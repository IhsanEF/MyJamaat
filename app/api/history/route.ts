import { logOperationalError } from "@/lib/operational-log";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { personalCsv } from "@/lib/personal-export";
import { takeQuota } from "@/lib/abuse-controls";
import { contentLengthTooLarge, readBoundedUtf8, RequestBodyError } from "@/lib/request-bounds";
import { NextRequest, NextResponse } from "next/server";

export const dynamic="force-dynamic";
type Row=Record<string,unknown>;
const fail=(message:string,status=400)=>NextResponse.json({error:message},{status});
const limited=(seconds:number)=>NextResponse.json({error:`Too many requests. Try again in ${seconds} seconds.`},{status:429,headers:{"Retry-After":String(seconds)}});
const categories={
  audit:{table:"audit",date:"created_at"},
  "recorded-revisions":{table:"recorded_revisions",date:"created_at"},
  "person-corrections":{table:"person_corrections",date:"created_at"},
  "repair-reviews":{table:"repair_reviews",date:"created_at"},
  people:{table:"people",date:"created_at"},
  objects:{table:"objects",date:"created_at"},
} as const;

async function identity(){
  const user=await getChatGPTUser();
  if(!user)return null;
  const db=env.DB;
  if(!db)throw new Error("Database unavailable");
  const person=await db.prepare("SELECT * FROM people WHERE auth_id=? AND merged_into_id IS NULL").bind(user.userId).first<Row>();
  return {db,person,user};
}
const leader=(person:Row)=>person.role==="admin"||person.role==="markaz_ameer";
const summary=(value:unknown)=>{
  let parsed:Record<string,unknown>={};
  try{const candidate=JSON.parse(String(value||"{}"));if(candidate&&typeof candidate==="object"&&!Array.isArray(candidate))parsed=candidate;}catch{}
  const safe:Record<string,unknown>={};
  for(const key of ["fields","previousRole","nextRole","previousScopes","nextScopes","previousStatus","nextStatus","reasonCategory","membershipId"]){
    const value=parsed[key];
    if(typeof value==="string")safe[key]=value.slice(0,80);
    else if(Array.isArray(value))safe[key]=value.filter(item=>typeof item==="string").slice(0,12).map(item=>item.slice(0,40));
  }
  return safe;
};

export async function GET(request:NextRequest){
  try{
    const ctx=await identity();
    if(!ctx)return fail("Please sign in.",401);
    const {db,person,user}=ctx;
    if(!person)return fail("Join a Markaz first.",403);
    const markazId=String(person.markaz_id),view=request.nextUrl.searchParams.get("view");
    if(view!=="mine"&&!leader(person))return fail("Only Markaz leaders can review this history.",403);
    const quota=view==="mine"?"export":"history";
    for(const [scope,subject] of [["user",user.userId],["tenant",markazId]] as const){const decision=await takeQuota(db,quota,scope,subject);if(!decision.allowed)return limited(decision.retryAfterSeconds);}
    if(view==="mine"){
      const rows:[string,string,string,unknown][]=[];
      for(const field of ["id","name","phone","email","role","claimed_role","local_masjid_id","local_markaz_id","national_markaz_id","created_at"]){
        rows.push(["person",String(person.id),field,person[field]]);
      }
      const memberships=(await db.prepare("SELECT id,jamaat_id,role,permissions,created_at FROM memberships WHERE markaz_id=? AND person_id=? ORDER BY created_at,id LIMIT 5001").bind(markazId,person.id).all<Row>()).results;
      if(memberships.length>5000)return fail("This record has too many memberships for a single export. Ask a Markaz administrator for a reviewed export.",413);
      for(const member of memberships){
        for(const field of ["jamaat_id","role","created_at"])rows.push(["membership",String(member.id),field,member[field]]);
        try{const permissions=JSON.parse(String(member.permissions||"{}"));if(Array.isArray(permissions.scopes))rows.push(["membership",String(member.id),"scopes",permissions.scopes.filter((value:unknown)=>typeof value==="string").join("; ")]);}catch{}
      }
      const corrections=(await db.prepare("SELECT id,created_at,actor_id,before_json,after_json FROM person_corrections WHERE markaz_id=? AND person_id=? ORDER BY created_at,id LIMIT 5001").bind(markazId,person.id).all<Row>()).results;
      if(corrections.length>5000)return fail("This record has too many corrections for a single export. Ask a Markaz administrator for a reviewed export.",413);
      for(const correction of corrections){
        rows.push(["contact_correction",String(correction.id),"created_at",correction.created_at]);
        rows.push(["contact_correction",String(correction.id),"actor_id",correction.actor_id]);
        for(const stage of ["before","after"] as const){
          try{const snapshot=JSON.parse(String(correction[`${stage}_json`]||"{}"));for(const field of ["name","phone","email"])rows.push(["contact_correction",String(correction.id),`${stage}.${field}`,snapshot[field]]);}catch{}
        }
      }
      const csv=personalCsv(rows);
      return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=\"my-jamaat-personal-records.csv\"","Cache-Control":"private, no-store"}});
    }
    if(view==="audit"){
      const cursor=request.nextUrl.searchParams.get("cursor");
      const parts=cursor?.split("|")||[];
      if(cursor&&(parts.length!==2||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(parts[0])||!/^[a-zA-Z0-9-]{1,80}$/.test(parts[1])))return fail("Invalid history cursor.");
      const rows=(await db.prepare(`SELECT a.id,a.actor_id,a.action,a.object_id,a.subject_id,a.summary_json,a.created_at,p.name AS actor_name,s.name AS subject_name FROM audit a LEFT JOIN people p ON p.id=a.actor_id AND p.markaz_id=a.markaz_id LEFT JOIN people s ON s.id=a.subject_id AND s.markaz_id=a.markaz_id WHERE a.markaz_id=? ${cursor?"AND (a.created_at<? OR (a.created_at=? AND a.id<?))":""} ORDER BY a.created_at DESC,a.id DESC LIMIT 101`).bind(markazId,...(cursor?[parts[0],parts[0],parts[1]]:[])).all<Row>()).results;
      const page=rows.slice(0,100),last=page.at(-1);
      return NextResponse.json({events:page.map(row=>({id:row.id,actorId:row.actor_id,actorName:row.actor_name||"Former member",action:row.action,objectId:row.object_id,subjectId:row.subject_id,subjectName:row.subject_name||null,summary:summary(row.summary_json),createdAt:row.created_at})),nextCursor:rows.length>100&&last?`${last.created_at}|${last.id}`:null});
    }
    if(view==="retention"){
      const policies=(await db.prepare("SELECT category,days,policy_reference,updated_by,updated_at FROM retention_policy WHERE markaz_id=?").bind(markazId).all<Row>()).results;
      const report=[];
      for(const [category,source] of Object.entries(categories)){
        const policy=policies.find(row=>row.category===category),days=policy?Number(policy.days):null;
        const cutoff=days?new Date(Date.now()-days*86400000).toISOString():null;
        const count=await db.prepare(`SELECT COUNT(*) AS total,MIN(${source.date}) AS oldest FROM ${source.table} WHERE markaz_id=?`).bind(markazId).first<Row>();
        const eligible=cutoff?await db.prepare(`SELECT COUNT(*) AS n FROM ${source.table} WHERE markaz_id=? AND ${source.date}<?`).bind(markazId,cutoff).first<Row>():null;
        report.push({category,configuredDays:days,total:Number(count?.total||0),oldest:count?.oldest||null,proposedCount:eligible?Number(eligible.n||0):null,action:"manual-review-only",policyReference:policy?.policy_reference||null,updatedBy:policy?.updated_by||null,updatedAt:policy?.updated_at||null});
      }
      return NextResponse.json({dryRun:true,deletionEnabled:false,report,policyDecisionRequired:policies.length===0});
    }
    return fail("Choose a history view.");
  }catch(error){logOperationalError("GET /api/history",error);return fail("History is temporarily unavailable. Please try again.",503);}
}

export async function POST(request:NextRequest){
  try{
    const origin=request.headers.get("origin");
    if(origin&&origin!==new URL(request.url).origin||request.headers.get("sec-fetch-site")==="cross-site")return fail("Cross-site requests are not allowed.",403);
    if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))return fail("Send JSON requests only.",415);
    if(contentLengthTooLarge(request))return fail("Request is too large.",413);
    const ctx=await identity();
    if(!ctx)return fail("Please sign in.",401);
    const {db,person,user}=ctx;
    if(!person||!leader(person))return fail("Only Markaz leaders can change record lifecycle settings.",403);
    for(const [scope,subject] of [["user",user.userId],["tenant",String(person.markaz_id)]] as const){const decision=await takeQuota(db,"write",scope,subject);if(!decision.allowed)return limited(decision.retryAfterSeconds);}
    let body:Record<string,unknown>;
    try{body=JSON.parse(await readBoundedUtf8(request));}catch(error){if(error instanceof RequestBodyError)return fail(error.message,error.status);return fail("Invalid request.");}
    if(!body||typeof body!=="object"||Array.isArray(body))return fail("Choose a supported history action.");
    if(body.action==="archiveRecord"||body.action==="restoreRecord"){
      const recordId=typeof body.id==="string"?body.id:"",expected=typeof body.expectedUpdatedAt==="string"?body.expectedUpdatedAt:"";
      if(!/^[a-zA-Z0-9:_-]{1,80}$/.test(recordId)||!expected)return fail("Reload the record before changing its lifecycle.",409);
      const current=await db.prepare("SELECT * FROM objects WHERE id=? AND markaz_id=?").bind(recordId,person.markaz_id).first<Row>();
      if(!current||!["note","tashkil","masjid_note","incident"].includes(String(current.kind)))return fail("Recorded item not found.",404);
      if(current.updated_at!==expected)return fail("This record changed. Reload and review it.",409);
      const archive=body.action==="archiveRecord";
      if(archive&&current.status==="archived"||!archive&&current.status!=="archived")return fail("This record lifecycle already changed. Reload it.",409);
      const reason=typeof body.reason==="string"?body.reason.trim():"";
      if(archive&&(reason.length<8||reason.length>500))return fail("Explain why this record should be archived (8 to 500 characters).");
      let original:Record<string,unknown>={};
      try{const parsed=JSON.parse(String(current.data));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))original=parsed;}catch{}
      if(archive&&await db.prepare("SELECT 1 FROM objects WHERE markaz_id=? AND parent_id=? LIMIT 1").bind(person.markaz_id,recordId).first<Row>())return fail("This record has linked items. Review those links before archiving.",409);
      if(!archive&&typeof original.archivePreviousStatus!=="string")return fail("This historical archive has no safe restore state. Review it manually.",409);
      const previousStatus=String(original.archivePreviousStatus||"recorded");
      const newStatus=archive?"archived":previousStatus;
      const nextData=archive?{...original,archivePreviousStatus:current.status,archiveReason:reason,archivedBy:person.id,archivedAt:new Date().toISOString()}:Object.fromEntries(Object.entries(original).filter(([key])=>!["archivePreviousStatus","archiveReason","archivedBy","archivedAt"].includes(key)));
      const stamp=new Date(Math.max(Date.now(),Date.parse(String(current.updated_at))+1)).toISOString(),guardId=crypto.randomUUID(),revisionId=crypto.randomUUID();
      try{await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS(SELECT 1 FROM objects WHERE id=? AND markaz_id=? AND updated_at=? AND status=?) THEN ? ELSE 'stale' END").bind(recordId,person.markaz_id,expected,current.status,guardId),
        db.prepare("UPDATE objects SET status=?,data=?,updated_at=? WHERE id=? AND markaz_id=? AND updated_at=?").bind(newStatus,JSON.stringify(nextData),stamp,recordId,person.markaz_id,expected),
        db.prepare("INSERT INTO recorded_revisions (id,markaz_id,object_id,kind,actor_id,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(revisionId,person.markaz_id,recordId,current.kind,person.id,archive?reason:"Restore archived record",JSON.stringify({title:current.title,status:current.status,data:original}),JSON.stringify({title:current.title,status:newStatus,data:nextData}),stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),person.markaz_id,person.id,`${current.kind}.${archive?"archive":"restore"}`,recordId,null,JSON.stringify({previousStatus:current.status,nextStatus:newStatus}),stamp),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId)
      ]);}catch{return fail("This record changed during saving. Reload and review it.",409);}
      return NextResponse.json({ok:true,status:newStatus,updatedAt:stamp});
    }
    if(body.action!=="setRetentionPolicy")return fail("Choose a supported history action.");
    if(person.role!=="admin")return fail("Only a Markaz administrator can record an approved retention policy.",403);
    if(typeof body.category!=="string"||!Object.hasOwn(categories,body.category)||!Number.isInteger(body.days)||Number(body.days)<1||Number(body.days)>36500||typeof body.policyReference!=="string"||body.policyReference.trim().length<8||body.policyReference.length>160)return fail("Choose a category, approved retention period and owner policy reference.");
    const category=body.category,days=Number(body.days),policyReference=body.policyReference.trim(),stamp=new Date().toISOString(),markazId=String(person.markaz_id);
    await db.batch([
      db.prepare("INSERT INTO retention_policy (markaz_id,category,days,policy_reference,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(markaz_id,category) DO UPDATE SET days=excluded.days,policy_reference=excluded.policy_reference,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(markazId,category,days,policyReference,person.id,stamp),
      db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),markazId,person.id,"retention.policy.record",category,null,JSON.stringify({fields:["days"]}),stamp)
    ]);
    return NextResponse.json({ok:true,dryRunOnly:true});
  }catch(error){logOperationalError("POST /api/history",error);return fail("Could not record the policy. Please try again.",503);}
}
