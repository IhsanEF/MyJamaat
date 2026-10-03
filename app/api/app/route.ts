import { logOperationalError } from "@/lib/operational-log";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { NextRequest, NextResponse } from "next/server";
import { amalForJamaat, isCalendarDate, mastooraatAmal, standardAmal } from "@/lib/amaal";
import { InputError, plainObject, createJamaatInput, createItemInput, createMashwaraInput, recordedRevisionInput, updateItemInput } from "@/lib/api-validation";
import { approvedAmeer, needsLegacyGrantReview, revokeUnverifiedGrant } from "@/lib/ameer-authority";
import { effectiveScopes, permissionFields, requestedScopes, type JamaatScope } from "@/lib/jamaat-permissions";
import { invitationHash, newInvitationToken, normalizeEmail, normalizeInvitationToken, replacePersonReferences } from "@/lib/onboarding";
import { candidateKey } from "@/lib/roster-import";
import { planRouteChange, stayFitsTrip, stayRangesOverlap, venueForDay, type RouteRow, type RouteChoice } from "@/lib/route-planning";
import { DEFAULT_TIME_ZONE, isCivilDate, isIanaTimeZone, localDateTimeInput, localDay, parseOffsetInstant, scheduleZone, temporalKind } from "@/lib/schedule-time";
import { seriesOccurrence, type RecurrenceRule } from "@/lib/mashwara-series";
import { validLedgerCents } from "@/lib/baraka";
import { outsideSurreyAddress, potentialDuplicate, surreyArea, type DirectoryPlace, type VenueType } from "@/lib/place-directory";
import { takeQuota, type QuotaGroup, type QuotaScope } from "@/lib/abuse-controls";
import { contentLengthTooLarge, readBoundedUtf8, RequestBodyError } from "@/lib/request-bounds";

export const dynamic = "force-dynamic";
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const clean = (value: unknown, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const data = (value: unknown) => {
  try { return JSON.parse(String(value || "{}")) as Record<string, unknown>; } catch { return {}; }
};
const fail = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
const limited = (seconds:number) => NextResponse.json({error:`Too many requests. Try again in ${seconds} seconds.`},{status:429,headers:{"Retry-After":String(seconds)}});
const nextStamp = (previous: unknown) => new Date(Math.max(Date.now(), Date.parse(String(previous || "")) + 1 || 0)).toISOString();
type Row = Record<string, unknown>;

async function materializeMashwaraSeries(db:NonNullable<typeof env.DB>,markazId:string) {
  const seriesRows=(await db.prepare("SELECT * FROM mashwara_series WHERE markaz_id = ?").bind(markazId).all<Row>()).results;
  for(const series of seriesRows){
    const nextIndex=Number(series.next_index);
    if(nextIndex>5200)continue;
    const changes=(await db.prepare("SELECT * FROM mashwara_series_changes WHERE series_id = ? ORDER BY start_index").bind(series.id).all<Row>()).results;
    const templates=(await db.prepare("SELECT * FROM mashwara_umoor_templates WHERE series_id = ?").bind(series.id).all<Row>()).results;
    const collaborators=(await db.prepare("SELECT person_id FROM mashwara_series_collaborators WHERE series_id = ?").bind(series.id).all<Row>()).results;
    const horizon=new Date(Date.now()+90*86400000).toISOString().slice(0,10);
    const stamp=now(),records:ReturnType<typeof db.prepare>[]=[],guardId=id();
    let created=0;
    for(let position=nextIndex;position<Math.min(nextIndex+12,5200);position++){
      const change=[...changes].reverse().find(row=>Number(row.start_index)<=position);
      if(!change)break;
      const rule:RecurrenceRule={anchorInstant:String(change.anchor_instant),timeZone:String(change.time_zone),frequency:String(change.frequency) as RecurrenceRule["frequency"],endCount:series.end_count===null?null:Number(series.end_count)-Number(change.start_index),endDay:series.end_day===null?null:String(series.end_day),monthlyAnchorDay:Number(data(change.template_data).monthAnchorDay||localDateTimeInput(String(change.anchor_instant),String(change.time_zone)).slice(8,10))};
      const occurrence=seriesOccurrence(rule,position-Number(change.start_index));
      if(!occurrence||occurrence.day>horizon&&position>=4)break;
      const occurrenceId=id(),fields={...data(change.template_data),seriesId:series.id,occurrence:position+1,recurrence:change.frequency,timeZone:change.time_zone};
      records.push(db.prepare("INSERT INTO objects (id,markaz_id,kind,title,start_at,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(occurrenceId,markazId,"mashwara",change.title,occurrence.instant,"planned",JSON.stringify(fields),series.created_by,stamp,stamp));
      records.push(db.prepare("INSERT INTO mashwara_occurrences (series_id,position,object_id,original_start_at,exception) VALUES (?,?,?,?,0)").bind(series.id,position,occurrenceId,occurrence.instant));
      for(const template of templates.filter(row=>Number(row.start_index)<=position&&(row.end_index===null||Number(row.end_index)>=position))){
        records.push(db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id(),markazId,"umoor",occurrenceId,template.title,"open",JSON.stringify({notes:template.notes,decision:"",followUp:"",recurring:true,seriesId:series.id,templateId:template.id}),template.created_by,stamp,stamp));
      }
      for(const collaborator of collaborators)records.push(db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id(),markazId,"collaborator",occurrenceId,"Planner","active",JSON.stringify({personId:collaborator.person_id,seriesId:series.id}),series.created_by,stamp,stamp));
      created++;
    }
    if(!created)continue;
    const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT version FROM mashwara_series WHERE id = ? AND markaz_id = ?) = ? AND (SELECT next_index FROM mashwara_series WHERE id = ?) = ? THEN ? ELSE 'stale' END").bind(series.id,markazId,series.version,series.id,nextIndex,guardId);
    try{await db.batch([guard,...records,db.prepare("UPDATE mashwara_series SET next_index = ? WHERE id = ?").bind(nextIndex+created,series.id),db.prepare("DELETE FROM route_assert WHERE id = ?").bind(guardId)]);}catch{/* A parallel load or edit generated this window. The next load reads its result. */}
  }
}

async function identity() {
  const user = await getChatGPTUser();
  if (!user) return null;
  const db = env.DB;
  if (!db) throw new Error("Database unavailable");
  const person = await db.prepare("SELECT * FROM people WHERE auth_id = ?").bind(user.userId).first<Row>();
  return { user, db, person };
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await identity();
    if (!ctx) return fail("Please sign in.", 401);
    const { db, person } = ctx;
    if (!person) {
      const count = await db.prepare("SELECT COUNT(*) AS n FROM markaz").first<{ n: number }>();
      return NextResponse.json({ setup: Number(count?.n || 0) === 0 ? "create-markaz" : "join-markaz" });
    }
    const candidateParentId = request.nextUrl.searchParams.get("candidateParentId") ?? request.nextUrl.searchParams.get("candidateJamaatId");
    if (candidateParentId !== null) {
      const query = request.nextUrl.searchParams.get("q")?.trim() || "";
      if (query.length < 2 || query.length > 60) return fail("Enter 2 to 60 characters to find a person.");
      const parent = await db.prepare("SELECT id,kind,parent_id,created_by,data FROM objects WHERE id = ? AND markaz_id = ?").bind(candidateParentId,person.markaz_id).first<Row>();
      if (!parent) return fail("Planning record not found.",404);
      const leader = person.role === "admin" || person.role === "markaz_ameer";
      let authorized = leader;
      let rosterJamaatId:unknown = null;
      if (parent.kind === "jamaat") {
        rosterJamaatId = parent.id;
        const member = await db.prepare("SELECT permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(parent.id,person.id,person.markaz_id).first<Row>();
        authorized ||= effectiveScopes({leader:false,jamaat:parent,details:data(parent.data),personId:person.id,member:!!member,permissions:data(member?.permissions)}).includes("roster");
      } else if (parent.kind === "mashwara") {
        const details = data(parent.data);
        authorized ||= parent.created_by === person.id || details.ameerId === person.id;
        if (details.daily === true) {
          const jamaat = await db.prepare("SELECT id,created_by,data FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat'").bind(parent.parent_id,person.markaz_id).first<Row>();
          const member = jamaat ? await db.prepare("SELECT permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(jamaat.id,person.id,person.markaz_id).first<Row>() : null;
          authorized = leader || (authorized && !!member);
          if (jamaat && member) authorized ||= effectiveScopes({leader:false,jamaat,details:data(jamaat.data),personId:person.id,member:true,permissions:data(member.permissions)}).includes("amaal");
        }
        const collaborator = await db.prepare("SELECT id FROM objects WHERE kind = 'collaborator' AND status <> 'removed' AND parent_id = ? AND markaz_id = ? AND json_extract(data,'$.personId') = ?").bind(parent.id,person.markaz_id,person.id).first<Row>();
        authorized ||= !!collaborator && (details.daily !== true || !!(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(parent.parent_id,person.id,person.markaz_id).first<Row>()));
      } else if (parent.kind === "team") {
        const event = await db.prepare("SELECT id,status FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'event'").bind(parent.parent_id,person.markaz_id).first<Row>();
        if (!event) return fail("Event not found.",404);
        authorized ||= ["planned","active"].includes(String(event.status)) && data(parent.data).personId === person.id;
      } else if (parent.kind !== "event") return fail("Choose a Jamaat, Mashwara, team, or event.");
      if (!authorized) return fail("You cannot find candidates for this plan.",403);
      const candidates = (await db.prepare("SELECT id,name FROM people WHERE markaz_id = ? AND merged_into_id IS NULL AND instr(lower(name),lower(?)) > 0 AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = people.id)) ORDER BY name LIMIT 10").bind(person.markaz_id,query,rosterJamaatId,rosterJamaatId).all<Row>()).results;
      return NextResponse.json({ candidates:candidates.map(candidate=>({id:candidate.id,name:candidate.name})) });
    }
    const markaz = await db.prepare("SELECT id, name, join_code, time_zone FROM markaz WHERE id = ?").bind(person.markaz_id).first<Row>();
    if(request.nextUrl.searchParams.get("objectCursor")===null)await materializeMashwaraSeries(db,String(person.markaz_id));
    const cursorText=request.nextUrl.searchParams.get("objectCursor");
    const cursorParts=cursorText?.split("|")||[];
    if(cursorText!==null&&cursorText!=="done"&&(cursorParts.length!==3||!["0","1","2","3","4"].includes(cursorParts[0])||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(cursorParts[1])||!/^[a-zA-Z0-9:_-]{1,80}$/.test(cursorParts[2])))return fail("Invalid record cursor.");
    const membershipCursor=request.nextUrl.searchParams.get("membershipCursor"),peopleCursor=request.nextUrl.searchParams.get("peopleCursor");
    if([membershipCursor,peopleCursor].some(value=>value!==null&&value!=="done"&&!/^[a-zA-Z0-9:_-]{1,80}$/.test(value)))return fail("Invalid roster cursor.");
    const coreKinds=new Set(["jamaat","event","stay","team","duty","assignment"]);
    const pageRank=(row:Row)=>coreKinds.has(String(row.kind))?0:row.kind==="mashwara"?(data(row.data)?.visibility==="private"?2:1):row.kind==="place"?3:4;
    const rankSql="CASE WHEN o.kind IN ('jamaat','event','stay','team','duty','assignment') THEN 0 WHEN o.kind='mashwara' AND COALESCE(CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.visibility') ELSE NULL END,'markaz')<>'private' THEN 1 WHEN o.kind='mashwara' THEN 2 WHEN o.kind='place' THEN 3 ELSE 4 END";
    const cursorClause=cursorText===null?"":`AND (${rankSql}>? OR (${rankSql}=? AND (created_at<? OR (created_at=? AND id<?))))`;
    const leaderRead=person.role==="admin"||person.role==="markaz_ameer";
    const scopeSql=leaderRead?"":`AND (
      o.kind IN ('place','event','team','duty','umoor','suggestion','opinion','collaborator','attendee','followup')
      OR (o.kind='jamaat' AND EXISTS(SELECT 1 FROM memberships m WHERE m.markaz_id=o.markaz_id AND m.jamaat_id=o.id AND m.person_id=?))
      OR (o.kind IN ('stay','assignment','message','note','money','tashkil','incident') AND EXISTS(SELECT 1 FROM memberships m WHERE m.markaz_id=o.markaz_id AND m.jamaat_id=o.parent_id AND m.person_id=?))
      OR (o.kind='masjid_note' AND EXISTS(SELECT 1 FROM memberships m WHERE m.markaz_id=o.markaz_id AND m.jamaat_id=CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.jamaatId') ELSE NULL END AND m.person_id=?))
      OR (o.kind='mashwara' AND CASE WHEN (CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.daily') ELSE NULL END)=1 THEN EXISTS(SELECT 1 FROM memberships m WHERE m.markaz_id=o.markaz_id AND m.jamaat_id=o.parent_id AND m.person_id=?) ELSE (
        COALESCE(CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.visibility') ELSE NULL END,'markaz')<>'private'
        OR o.created_by=? OR CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerId')=? ELSE 0 END
        OR EXISTS(SELECT 1 FROM objects c WHERE c.markaz_id=o.markaz_id AND c.parent_id=o.id AND c.kind='collaborator' AND c.status<>'removed' AND CASE WHEN json_valid(c.data) THEN json_extract(c.data,'$.personId')=? ELSE 0 END)
        OR EXISTS(SELECT 1 FROM mashwara_series_collaborators c WHERE c.series_id=CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.seriesId') ELSE NULL END AND c.person_id=?)
      ) END)
    )`;
    const objectPage=cursorText==="done"?[]:(await db.prepare(`SELECT o.* FROM objects o WHERE o.markaz_id=? ${scopeSql} ${cursorClause} ORDER BY ${rankSql},o.created_at DESC,o.id DESC LIMIT 501`).bind(person.markaz_id,...(leaderRead?[]:Array(8).fill(person.id)),...(cursorText===null?[]:[Number(cursorParts[0]),Number(cursorParts[0]),cursorParts[1],cursorParts[1],cursorParts[2]])).all<Row>()).results;
    const candidates=objectPage.slice(0,500);
    const lastCandidate=candidates.at(-1);
    const nextObjectCursor=objectPage.length>500&&lastCandidate?`${pageRank(lastCandidate)}|${lastCandidate.created_at}|${lastCandidate.id}`:null;
    const allObjects=[...candidates];
    const knownObjects=new Set(allObjects.map(row=>String(row.id)));
    let parentIds=[...new Set(allObjects.map(row=>String(row.parent_id||"")).filter(Boolean))];
    for(let depth=0;depth<2&&parentIds.length;depth++){
      const nextParents:Row[]=[];
      for(let offset=0;offset<parentIds.length;offset+=80){
        const batch=parentIds.slice(offset,offset+80).filter(parentId=>!knownObjects.has(parentId));
        if(batch.length)nextParents.push(...(await db.prepare(`SELECT * FROM objects WHERE markaz_id=? AND id IN (${batch.map(()=>"?").join(",")})`).bind(person.markaz_id,...batch).all<Row>()).results);
      }
      for(const row of nextParents){if(!knownObjects.has(String(row.id))){knownObjects.add(String(row.id));allObjects.push(row);}}
      parentIds=[...new Set(nextParents.map(row=>String(row.parent_id||"")).filter(Boolean))];
    }
    const ownMemberships = (await db.prepare("SELECT * FROM memberships WHERE markaz_id = ? AND person_id = ?").bind(person.markaz_id,person.id).all<Row>()).results;
    const ownJamaatIds=[...new Set(ownMemberships.map(row=>String(row.jamaat_id)))].filter(jamaatId=>!knownObjects.has(jamaatId));
    for(let offset=0;offset<ownJamaatIds.length;offset+=80){
      const batch=ownJamaatIds.slice(offset,offset+80);
      for(const root of (await db.prepare(`SELECT * FROM objects WHERE markaz_id=? AND kind='jamaat' AND id IN (${batch.map(()=>"?").join(",")})`).bind(person.markaz_id,...batch).all<Row>()).results){knownObjects.add(String(root.id));allObjects.push(root);}
    }
    const mySeriesGrants=new Set((await db.prepare("SELECT c.series_id FROM mashwara_series_collaborators c JOIN mashwara_series s ON s.id=c.series_id WHERE s.markaz_id=? AND c.person_id=?").bind(person.markaz_id,person.id).all<Row>()).results.map(row=>String(row.series_id)));
    const isMarkazLeader = person.role === "admin" || person.role === "markaz_ameer";
    const decisionRows = isMarkazLeader ? (await db.prepare("SELECT jamaat_id, actor_id, action, subject_id, previous_ameer_id, created_at FROM ameer_decisions WHERE markaz_id = ? ORDER BY created_at DESC LIMIT 500").bind(person.markaz_id).all<Row>()).results : [];
    const reviewRows = isMarkazLeader ? (await db.prepare("SELECT id,kind,target_id,original,status,created_at FROM repair_reviews WHERE markaz_id = ? AND status = 'needs-review' ORDER BY created_at DESC LIMIT 500").bind(person.markaz_id).all<Row>()).results : [];
    const invitations = isMarkazLeader ? (await db.prepare("SELECT id,person_id,mode,created_at,expires_at,revoked_at,claimed_at FROM invitations WHERE markaz_id = ? ORDER BY created_at DESC LIMIT 200").bind(person.markaz_id).all<Row>()).results : [];
    const claimRequests = isMarkazLeader ? (await db.prepare("SELECT id,invitation_id,target_person_id,source_person_id,status,created_at,reviewed_at FROM claim_requests WHERE markaz_id = ? ORDER BY created_at DESC LIMIT 200").bind(person.markaz_id).all<Row>()).results : [];
    const myClaimRequests = (await db.prepare("SELECT id,target_person_id,status,created_at FROM claim_requests WHERE markaz_id = ? AND claimant_auth_id = ? ORDER BY created_at DESC LIMIT 10").bind(person.markaz_id,person.auth_id).all<Row>()).results;
    const corrections = isMarkazLeader ? (await db.prepare("SELECT id,person_id,actor_id,before_json,after_json,created_at FROM person_corrections WHERE markaz_id = ? ORDER BY created_at DESC LIMIT 100").bind(person.markaz_id).all<Row>()).results : [];
    const myJamaats = new Set(ownMemberships.map(m => m.jamaat_id));
    const jamaatFor = (jamaatId:unknown) => allObjects.find(o => o.id === jamaatId && o.kind === "jamaat");
    const scopeCache = new Map<unknown,JamaatScope[]>();
    const scopesFor = (jamaatId:unknown) => {
      if (scopeCache.has(jamaatId)) return scopeCache.get(jamaatId)!;
      const jamaat = jamaatFor(jamaatId), membership = ownMemberships.find(m=>m.jamaat_id===jamaatId);
      const scopes = jamaat ? effectiveScopes({leader:isMarkazLeader,jamaat,details:data(jamaat.data),personId:person.id,member:!!membership,permissions:data(membership?.permissions)}) : [];
      scopeCache.set(jamaatId,scopes);
      return scopes;
    };
    const hasScope = (jamaatId:unknown,scope:JamaatScope) => scopesFor(jamaatId).includes(scope);
    const allowedJamaats = myJamaats;
    const plannedMashwaras=new Set<unknown>();
    const pageMeetingIds=allObjects.filter(row=>row.kind==="mashwara").map(row=>String(row.id));
    for(let offset=0;offset<pageMeetingIds.length;offset+=80){
      const batch=pageMeetingIds.slice(offset,offset+80);
      for(const row of (await db.prepare(`SELECT parent_id FROM objects WHERE markaz_id=? AND kind='collaborator' AND status<>'removed' AND parent_id IN (${batch.map(()=>"?").join(",")}) AND CASE WHEN json_valid(data) THEN json_extract(data,'$.personId')=? ELSE 0 END`).bind(person.markaz_id,...batch,person.id).all<Row>()).results)plannedMashwaras.add(row.parent_id);
    }
    for(const meeting of allObjects.filter(row=>row.kind==="mashwara"&&mySeriesGrants.has(String(data(row.data).seriesId||""))))plannedMashwaras.add(meeting.id);
    const canViewMashwara = (m: Row | undefined) => {
      if (!m || m.kind !== "mashwara") return false;
      const md = data(m.data);
      if (md.daily === true) return allowedJamaats.has(m.parent_id);
      return md.visibility !== "private" || m.created_by === person.id || md.ameerId === person.id || plannedMashwaras.has(m.id);
    };
    const visible = candidates.filter(o => {
      if (isMarkazLeader) return true;
      if (o.kind === "place") return true;
      if (o.kind === "mashwara") return canViewMashwara(o);
      if (o.kind === "umoor" || o.kind === "suggestion") {
        const parent = allObjects.find(x => x.id === o.parent_id);
        return canViewMashwara(parent);
      }
      if (o.kind === "opinion" || o.kind === "collaborator" || o.kind === "attendee" || o.kind === "followup") {
        const umoor = allObjects.find(x => x.id === o.parent_id);
        const mashwara = umoor?.kind === "mashwara" ? umoor : allObjects.find(x => x.id === umoor?.parent_id);
        if (!canViewMashwara(mashwara)) return false;
        if (data(mashwara?.data).daily === true) return canViewMashwara(mashwara);
        return o.created_by === person.id || data(o.data).ownerId === person.id || mashwara?.created_by === person.id || data(mashwara?.data).ameerId === person.id || plannedMashwaras.has(mashwara?.id);
      }
      if (o.kind === "jamaat") return allowedJamaats.has(o.id);
      if (o.kind === "stay" || o.kind === "assignment" || o.kind === "message") return allowedJamaats.has(o.parent_id);
      if (o.kind === "event") return true;
      if (o.kind === "team" || o.kind === "duty") return true;
      if (o.kind === "masjid_note") return hasScope(data(o.data).jamaatId,"notes");
      if (o.kind === "note") return hasScope(o.parent_id,"notes");
      if (o.kind === "money") return hasScope(o.parent_id,"funds");
      if (o.kind === "tashkil") return hasScope(o.parent_id,"tashkil");
      if (o.kind === "incident") return hasScope(o.parent_id,"incidents");
      return false;
    }).map(o => ({ id:o.id, kind:o.kind, parentId:o.parent_id, title:o.title, startAt:o.start_at, endAt:o.end_at, status:o.status, data:{...data(o.data),...(o.kind==="mashwara"&&mySeriesGrants.has(String(data(o.data).seriesId||""))?{isSeriesPlanner:true}:{})} as Record<string,unknown>, createdBy:o.created_by, createdAt:o.created_at, updatedAt:o.updated_at }));
    const placeIds=[...new Set([person.local_masjid_id,person.local_markaz_id,person.national_markaz_id,...visible.flatMap(item=>[item.data.placeId,item.data.locationId])].filter((value):value is string=>typeof value==="string"&&value.length>0))].filter(placeId=>!visible.some(item=>item.id===placeId));
    const pinnedPlaces:Row[]=[];
    for(let offset=0;offset<placeIds.length;offset+=80){
      const batch=placeIds.slice(offset,offset+80);
      pinnedPlaces.push(...(await db.prepare(`SELECT * FROM objects WHERE markaz_id=? AND kind='place' AND id IN (${batch.map(()=>"?").join(",")})`).bind(person.markaz_id,...batch).all<Row>()).results);
    }
    const relatedPlaces=pinnedPlaces.map(o=>({id:o.id,kind:o.kind,parentId:o.parent_id,title:o.title,startAt:o.start_at,endAt:o.end_at,status:o.status,data:data(o.data),createdBy:o.created_by,createdAt:o.created_at,updatedAt:o.updated_at}));
    const visibleRecordedIds=new Set(visible.filter(o=>["note","tashkil","masjid_note","incident"].includes(String(o.kind))).map(o=>o.id));
    const revisionRows:Row[]=[];
    const revisionIds=[...visibleRecordedIds].map(String);
    for(let offset=0;offset<revisionIds.length;offset+=80){
      const batch=revisionIds.slice(offset,offset+80);
      revisionRows.push(...(await db.prepare(`SELECT id,object_id,kind,actor_id,reason,before_json,after_json,created_at FROM recorded_revisions WHERE markaz_id=? AND object_id IN (${batch.map(()=>"?").join(",")}) ORDER BY created_at DESC LIMIT 1000`).bind(person.markaz_id,...batch).all<Row>()).results);
    }
    const recordedRevisions=revisionRows.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,1000).map(row=>({id:row.id,objectId:row.object_id,kind:row.kind,actorId:row.actor_id,reason:row.reason,before:data(row.before_json),after:data(row.after_json),createdAt:row.created_at}));
    const membershipScope=isMarkazLeader?"": "AND jamaat_id IN (SELECT jamaat_id FROM memberships WHERE markaz_id=? AND person_id=?)";
    const membershipPage=membershipCursor==="done"?[]:(await db.prepare(`SELECT * FROM memberships WHERE markaz_id=? ${membershipScope} ${membershipCursor?"AND id<?":""} ORDER BY id DESC LIMIT 201`).bind(person.markaz_id,...(isMarkazLeader?[]:[person.markaz_id,person.id]),...(membershipCursor?[membershipCursor]:[])).all<Row>()).results;
    const allMemberships=membershipPage.slice(0,200);
    const nextMembershipCursor=membershipPage.length>200?String(allMemberships.at(-1)?.id):null;
    const memberJamaatIds=[...new Set(allMemberships.map(row=>String(row.jamaat_id)))].filter(jamaatId=>!knownObjects.has(jamaatId));
    for(let offset=0;offset<memberJamaatIds.length;offset+=80){
      const batch=memberJamaatIds.slice(offset,offset+80);
      const roots=(await db.prepare(`SELECT * FROM objects WHERE markaz_id=? AND kind='jamaat' AND id IN (${batch.map(()=>"?").join(",")})`).bind(person.markaz_id,...batch).all<Row>()).results;
      for(const root of roots){knownObjects.add(String(root.id));allObjects.push(root);}
    }
    const visibleSeriesIds=new Set(visible.filter(o=>o.kind==="mashwara").map(o=>String(o.data.seriesId||"")));
    const seriesPlannerRows:Row[]=[],seriesRows:Row[]=[];
    const scopedSeriesIds=[...visibleSeriesIds].filter(Boolean);
    for(let offset=0;offset<scopedSeriesIds.length;offset+=80){
      const batch=scopedSeriesIds.slice(offset,offset+80),slots=batch.map(()=>"?").join(",");
      seriesRows.push(...(await db.prepare(`SELECT id,anchor_instant,time_zone,frequency,end_count,end_day,next_index,version FROM mashwara_series WHERE markaz_id=? AND id IN (${slots})`).bind(person.markaz_id,...batch).all<Row>()).results);
      seriesPlannerRows.push(...(await db.prepare(`SELECT c.series_id,c.person_id FROM mashwara_series_collaborators c JOIN mashwara_series s ON s.id=c.series_id WHERE s.markaz_id=? AND c.series_id IN (${slots})`).bind(person.markaz_id,...batch).all<Row>()).results);
    }
    const seriesOut=seriesRows.map(row=>({id:row.id,anchorInstant:row.anchor_instant,timeZone:row.time_zone,frequency:row.frequency,endCount:row.end_count,endDay:row.end_day,nextIndex:row.next_index,version:row.version,plannerIds:seriesPlannerRows.filter(grant=>grant.series_id===row.id).map(grant=>grant.person_id)}));
    const members = allMemberships.map(m => {
      const permissions = data(m.permissions), jamaat = jamaatFor(m.jamaat_id);
      const scopes = jamaat ? effectiveScopes({leader:false,jamaat,details:data(jamaat.data),personId:m.person_id,member:true,permissions}) : [];
      return { id:m.id, jamaatId:m.jamaat_id, personId:m.person_id, role:m.role, permissions:{...permissions,scopes,manage:["roster","route","amaal"].every(scope=>scopes.includes(scope as JamaatScope)),viewContacts:scopes.includes("contacts"),needsReview:needsLegacyGrantReview(permissions)} };
    });
    const nameIds = new Set<unknown>([person.id]);
    for (const member of allMemberships) nameIds.add(member.person_id);
    for (const item of visible) {
      nameIds.add(item.createdBy);
      for (const key of ["personId","ameerId","authorId","reportedBy","ownerId","reviewedBy","completedBy"]) if (typeof item.data[key] === "string") nameIds.add(item.data[key]);
      if (Array.isArray(item.data.personIds)) for (const participant of item.data.personIds) if (typeof participant === "string") nameIds.add(participant);
    }
    for(const revision of recordedRevisions)nameIds.add(revision.actorId);
    for(const series of seriesOut)for(const plannerId of series.plannerIds)nameIds.add(plannerId);
    const allPeople:Row[]=[];
    const leaderPeoplePage=isMarkazLeader&&peopleCursor!=="done"?(await db.prepare(`SELECT * FROM people WHERE markaz_id=? AND merged_into_id IS NULL ${peopleCursor?"AND id<?":""} ORDER BY id DESC LIMIT 201`).bind(person.markaz_id,...(peopleCursor?[peopleCursor]:[])).all<Row>()).results:[];
    const nextPeopleCursor=leaderPeoplePage.length>200?String(leaderPeoplePage[199].id):null;
    allPeople.push(...leaderPeoplePage.slice(0,200));
    const knownPeople=new Set(allPeople.map(row=>String(row.id)));
    const ids=[...nameIds].filter((value):value is string=>typeof value==="string"&&value.length>0&&!knownPeople.has(value));
    for(let offset=0;offset<ids.length;offset+=80){
      const batch=ids.slice(offset,offset+80);
      allPeople.push(...(await db.prepare(`SELECT * FROM people WHERE markaz_id=? AND merged_into_id IS NULL AND id IN (${batch.map(()=>"?").join(",")})`).bind(person.markaz_id,...batch).all<Row>()).results);
    }
    allPeople.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    const visiblePeople = allPeople;
    const contactPersonIds=new Set<string>([String(person.id)]);
    if(!isMarkazLeader){
      const contactJamaatIds=ownMemberships.filter(row=>hasScope(row.jamaat_id,"contacts")).map(row=>String(row.jamaat_id));
      const visiblePersonIds=[...nameIds].filter((value):value is string=>typeof value==="string"&&value.length>0);
      for(let j=0;j<contactJamaatIds.length;j+=40)for(let p=0;p<visiblePersonIds.length;p+=40){
        const jamaatBatch=contactJamaatIds.slice(j,j+40),personBatch=visiblePersonIds.slice(p,p+40);
        for(const row of (await db.prepare(`SELECT DISTINCT person_id FROM memberships WHERE markaz_id=? AND jamaat_id IN (${jamaatBatch.map(()=>"?").join(",")}) AND person_id IN (${personBatch.map(()=>"?").join(",")})`).bind(person.markaz_id,...jamaatBatch,...personBatch).all<Row>()).results)contactPersonIds.add(String(row.person_id));
      }
    }
    const peopleOut = visiblePeople.map(p => {
      const mayViewContact = isMarkazLeader || contactPersonIds.has(String(p.id));
      const profile = isMarkazLeader || p.id === person.id;
      return { id:p.id, name:p.name, role:profile?p.role:"worker", claimedRole:profile?p.claimed_role:"worker", phone:mayViewContact?p.phone:null, email:mayViewContact?p.email:null, localMasjidId:profile?p.local_masjid_id:null, localMarkazId:profile?p.local_markaz_id:null, nationalMarkazId:profile?p.national_markaz_id:null, linked:profile?!!p.auth_id:false };
    });
    return NextResponse.json({ setup:"ready", nextObjectCursor, nextMembershipCursor, nextPeopleCursor, relatedPlaces, markaz:{ id:markaz?.id, name:markaz?.name, joinCode:isMarkazLeader?markaz?.join_code:null, timeZone:scheduleZone(markaz?.time_zone) }, me:{ id:person.id, name:person.name, role:person.role, claimedRole:person.claimed_role, phone:person.phone, email:person.email, localMasjidId:person.local_masjid_id, localMarkazId:person.local_markaz_id, nationalMarkazId:person.national_markaz_id, linked:true }, people:peopleOut, objects:visible, memberships:members, series:seriesOut, ameerDecisions:decisionRows.map(row=>({ jamaatId:row.jamaat_id,actorId:row.actor_id,action:row.action,subjectId:row.subject_id,previousAmeerId:row.previous_ameer_id,createdAt:row.created_at })), repairReviews:reviewRows.map(row=>({id:row.id,kind:row.kind,targetId:row.target_id,original:row.original,status:row.status,createdAt:row.created_at})), invitations:invitations.map(row=>({id:row.id,personId:row.person_id,mode:row.mode,createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,claimedAt:row.claimed_at})), claimRequests:claimRequests.map(row=>({id:row.id,invitationId:row.invitation_id,targetPersonId:row.target_person_id,sourcePersonId:row.source_person_id,status:row.status,createdAt:row.created_at,reviewedAt:row.reviewed_at})), myClaimRequests:myClaimRequests.map(row=>({id:row.id,targetPersonId:row.target_person_id,status:row.status,createdAt:row.created_at})), recordedRevisions, contactCorrections:corrections.map(row=>({id:row.id,personId:row.person_id,actorId:row.actor_id,before:JSON.parse(String(row.before_json)),after:JSON.parse(String(row.after_json)),createdAt:row.created_at})) });
  } catch (error) {
    logOperationalError("GET /api/app", error);
    return fail("The workspace could not be loaded. Please try again.", 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return fail("Cross-site requests are not allowed.",403);
    if(request.headers.get("sec-fetch-site")==="cross-site")return fail("Cross-site requests are not allowed.",403);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail("Send JSON requests only.",415);
    if(contentLengthTooLarge(request))return fail("Request is too large.",413);
    const ctx = await identity();
    if (!ctx) return fail("Please sign in.", 401);
    let raw:string;
    try{raw=await readBoundedUtf8(request);}catch(error){if(error instanceof RequestBodyError)return fail(error.message,error.status);throw error;}
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return fail("Invalid request."); }
    if (!plainObject(body)) return fail("Request must be a JSON object.");
    const { db, user, person } = ctx;
    const action = clean(body.action, 40);
    const checkQuota=async(group:QuotaGroup,scope:QuotaScope,subject:string)=>{
      const decision=await takeQuota(db,group,scope,subject);
      return decision.allowed?null:limited(decision.retryAfterSeconds);
    };
    const userLimit=await checkQuota("write","user",user.userId);
    if(userLimit)return userLimit;
    if(person){const tenantLimit=await checkQuota("write","tenant",String(person.markaz_id));if(tenantLimit)return tenantLimit;}
    if (action === "createMarkaz") {
      if (person) return fail("You already belong to a Markaz.");
      const count = await db.prepare("SELECT COUNT(*) AS n FROM markaz").first<{ n:number }>();
      if (Number(count?.n || 0) !== 0) return fail("A Markaz already exists. Ask its admin for a join code.", 403);
      const name = clean(body.name, 100);
      const yourName = clean(body.yourName, 100);
      if (!name || !yourName) return fail("Enter the Markaz and your name.");
      const timeZone = body.timeZone === undefined ? DEFAULT_TIME_ZONE : body.timeZone;
      if (!isIanaTimeZone(timeZone)) return fail("Choose a valid IANA timezone.");
      const mid = id(), pid = id(), stamp = now();
      const code = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
      await db.batch([
        db.prepare("INSERT INTO markaz (id,name,join_code,time_zone,created_by,created_at) VALUES (?,?,?,?,?,?)").bind(mid,name,code,timeZone,user.userId,stamp),
        db.prepare("INSERT INTO people (id,markaz_id,auth_id,name,email,role,claimed_role,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(pid,mid,user.userId,yourName,user.email,"admin","ameer",stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(),mid,pid,"markaz.create",mid,pid,"{}",stamp)
      ]);
      return NextResponse.json({ ok:true });
    }
    if (action === "joinMarkaz") {
      if (person) return fail("You already belong to a Markaz.");
      const joinLimit=await checkQuota("join","user",user.userId);
      if(joinLimit)return joinLimit;
      const code = clean(body.code, 30).toUpperCase();
      const name = clean(body.name, 100);
      if (!code || !name) return fail("Enter your name and join code.");
      const m = await db.prepare("SELECT id FROM markaz WHERE join_code = ?").bind(code).first<Row>();
      if (!m) return fail("Join code not found.");
      const tenantJoinLimit=await checkQuota("join","tenant",String(m.id));
      if(tenantJoinLimit)return tenantJoinLimit;
      const claimed = body.claimedRole === "ameer" ? "ameer" : "worker";
      const pid=id(),stamp=now();
      await db.batch([
        db.prepare("INSERT INTO people (id,markaz_id,auth_id,name,email,role,claimed_role,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(pid,m.id,user.userId,name,user.email,"worker",claimed,stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(),m.id,pid,"person.join",pid,pid,"{}",stamp)
      ]);
      return NextResponse.json({ ok:true });
    }
    if (action === "claimInvitation") {
      const claimLimit=await checkQuota("claim","user",user.userId);
      if(claimLimit)return claimLimit;
      const token = normalizeInvitationToken(body.token);
      if (!token) return fail("Enter the full personal invitation code.");
      const hash = await invitationHash(token);
      const invitation = await db.prepare("SELECT i.*,p.email AS person_email,p.auth_id AS person_auth_id,p.merged_into_id AS person_merged_into_id FROM invitations i JOIN people p ON p.id = i.person_id AND p.markaz_id = i.markaz_id WHERE i.token_hash = ?").bind(hash).first<Row>();
      if (!invitation) return fail("This personal invitation is invalid or unavailable.",404);
      const tenantClaimLimit=await checkQuota("claim","tenant",String(invitation.markaz_id));
      if(tenantClaimLimit)return tenantClaimLimit;
      if (invitation.revoked_at || invitation.claimed_at || String(invitation.expires_at) <= now()) return fail("This personal invitation has expired or was used. Ask a Markaz leader for a new one.",410);
      if (invitation.person_auth_id || invitation.person_merged_into_id) return fail("This roster record is already linked. Ask a Markaz leader to review it.",409);
      if (invitation.mode === "email-bound" && normalizeEmail(user.email) !== invitation.required_email) return fail("This invitation is for a different signed-in email. Ask a Markaz leader to review it.",403);
      if (person && person.markaz_id !== invitation.markaz_id) return fail("This invitation belongs to another Markaz.",403);
      const existingRequest = await db.prepare("SELECT id,status,claimant_auth_id FROM claim_requests WHERE invitation_id = ?").bind(invitation.id).first<Row>();
      if (existingRequest) return existingRequest.claimant_auth_id === user.userId && existingRequest.status === "pending" ? NextResponse.json({ok:true,pending:true}) : fail("This invitation already has a claim request. Ask a Markaz leader to review it.",409);
      const stamp = now();
      if (person) {
        if (person.role !== "worker") return fail("A Markaz leader must review this account separately.",403);
        const requestId = id();
        try { await db.batch([
          db.prepare("INSERT INTO claim_requests (id,markaz_id,invitation_id,target_person_id,source_person_id,claimant_auth_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(requestId,invitation.markaz_id,invitation.id,invitation.person_id,person.id,user.userId,"pending",stamp),
          db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(),invitation.markaz_id,person.id,"person.claim.request",requestId,invitation.person_id,"{}",stamp)
        ]); }
        catch { return fail("This invitation already has a claim request. Reload its status or ask a Markaz leader to review it.",409); }
        return NextResponse.json({ok:true,pending:true});
      }
      try { await db.batch([
        db.prepare("UPDATE people SET auth_id = ? WHERE id = ? AND markaz_id = ? AND auth_id IS NULL AND merged_into_id IS NULL AND EXISTS (SELECT 1 FROM invitations i WHERE i.id = ? AND i.person_id = people.id AND i.revoked_at IS NULL AND i.claimed_at IS NULL AND i.expires_at > ? AND NOT EXISTS (SELECT 1 FROM claim_requests WHERE invitation_id = i.id))").bind(user.userId,invitation.person_id,invitation.markaz_id,invitation.id,stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 THEN 'person.claim.link' ELSE NULL END,?,?,?,?)").bind(id(),invitation.markaz_id,invitation.person_id,invitation.person_id,invitation.person_id,JSON.stringify({fields:["auth-link"]}),stamp),
        db.prepare("UPDATE invitations SET claimed_at = ?,claimed_auth_id = ? WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM people WHERE id = invitations.person_id AND auth_id = ?)").bind(stamp,user.userId,invitation.id,stamp,user.userId),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 THEN 'person.claim.invitation' ELSE NULL END,?,?,?,?)").bind(id(),invitation.markaz_id,invitation.person_id,invitation.id,invitation.person_id,"{}",stamp)
      ]); }
      catch { return fail("This invitation changed. Reload and ask for a new code if needed.",409); }
      return NextResponse.json({ok:true,claimed:true});
    }
    if (!person) return fail("Join a Markaz first.", 403);
    const leader = person.role === "admin" || person.role === "markaz_ameer";
    const markazId = String(person.markaz_id);
    const markazZone = scheduleZone((await db.prepare("SELECT time_zone FROM markaz WHERE id = ?").bind(markazId).first<Row>())?.time_zone);
    const object = async (objectId: unknown) => db.prepare("SELECT * FROM objects WHERE id = ? AND markaz_id = ?").bind(clean(objectId, 80), markazId).first<Row>();
    const personInMarkaz = async (personId: unknown) => db.prepare("SELECT * FROM people WHERE id = ? AND markaz_id = ? AND merged_into_id IS NULL").bind(clean(personId, 80), markazId).first<Row>();
    const hasJamaatScope = async (jamaat:Row,scope:JamaatScope) => {
      if (leader) return true;
      const membership = await db.prepare("SELECT permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(jamaat.id,person.id,markazId).first<Row>();
      return effectiveScopes({leader:false,jamaat,details:data(jamaat.data),personId:person.id,member:!!membership,permissions:data(membership?.permissions)}).includes(scope);
    };
    const currentAmeer = async (jamaat:Row) => approvedAmeer(data(jamaat.data),person.id)
      && !!(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(jamaat.id,person.id,markazId).first<Row>());
    const leadsApprovedJamaat = async () => !!(await db.prepare("SELECT 1 FROM objects j JOIN memberships m ON m.jamaat_id = j.id AND m.markaz_id = j.markaz_id WHERE j.markaz_id = ? AND j.kind = 'jamaat' AND m.person_id = ? AND json_extract(j.data,'$.ameerStatus') = 'approved' AND json_extract(j.data,'$.ameerId') = ? LIMIT 1").bind(markazId,person.id,person.id).first<Row>());
    const guardedGlobalAudit = (label:string,objectId:string) => db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,created_at) VALUES (?,?,?,CASE WHEN EXISTS (SELECT 1 FROM people actor WHERE actor.id = ? AND actor.markaz_id = ? AND actor.role IN ('admin','markaz_ameer')) OR EXISTS (SELECT 1 FROM objects j JOIN memberships m ON m.jamaat_id = j.id AND m.markaz_id = j.markaz_id WHERE j.markaz_id = ? AND j.kind = 'jamaat' AND m.person_id = ? AND json_extract(j.data,'$.ameerStatus') = 'approved' AND json_extract(j.data,'$.ameerId') = ?) THEN ? ELSE NULL END,?,?)").bind(id(),markazId,person.id,person.id,markazId,markazId,person.id,person.id,label,objectId,now());
    const auditChange = (label:string, objectId:string|null, subjectId:string|null=null, summary:Record<string,unknown>={}) => db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(),markazId,person.id,label,objectId,subjectId,JSON.stringify(summary),now());
    const ameerDecision = (jamaatId:string,action:string,subjectId:string,previousAmeerId:string|null) => db.prepare("INSERT INTO ameer_decisions (id,markaz_id,jamaat_id,actor_id,action,subject_id,previous_ameer_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(),markazId,jamaatId,person.id,action,subjectId,previousAmeerId,now());
    if (action === "setMarkazTimeZone") {
      if (!leader) return fail("Only Markaz leaders can set the timezone.",403);
      if (!isIanaTimeZone(body.timeZone)) return fail("Choose a valid IANA timezone.");
      await db.batch([
        db.prepare("UPDATE markaz SET time_zone = ? WHERE id = ?").bind(body.timeZone,markazId),
        auditChange("markaz.time-zone",markazId)
      ]);
      return NextResponse.json({ok:true,timeZone:body.timeZone});
    }
    if (action === "createInvitation") {
      if (!leader) return fail("Only Markaz leaders can create personal invitations.",403);
      const inviteLimit=await checkQuota("invite","user",user.userId);
      if(inviteLimit)return inviteLimit;
      const tenantInviteLimit=await checkQuota("invite","tenant",markazId);
      if(tenantInviteLimit)return tenantInviteLimit;
      const target = await db.prepare("SELECT id,name,email,auth_id,merged_into_id FROM people WHERE id = ? AND markaz_id = ?").bind(clean(body.personId,80),markazId).first<Row>();
      if (!target) return fail("Person not found in this Markaz.",404);
      if (target.auth_id || target.merged_into_id) return fail("This person already has an account or was merged.",409);
      const mode = body.mode === "assisted" ? "assisted" : body.mode === "email-bound" ? "email-bound" : "";
      if (!mode) return fail("Choose email-bound or assisted verification.");
      const requiredEmail = normalizeEmail(target.email);
      if (mode === "email-bound" && !requiredEmail) return fail("This person has no email. Use assisted verification after confirming their identity.");
      if (mode === "assisted" && body.identityConfirmed !== true) return fail("Confirm that a leader verified this person before making an assisted invitation.");
      const days = body.expiresDays === undefined ? 7 : body.expiresDays;
      if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 14) return fail("Choose an expiry from 1 to 14 days.");
      const pending = await db.prepare("SELECT id FROM claim_requests WHERE target_person_id = ? AND markaz_id = ? AND status = 'pending'").bind(target.id,markazId).first<Row>();
      if (pending) return fail("Review the pending claim before issuing another invitation.",409);
      const token = newInvitationToken(), hash = await invitationHash(token), invitationId = id(), stamp = now();
      const expiresAt = new Date(Date.now()+Number(days)*86400000).toISOString();
      await db.batch([
        db.prepare("UPDATE invitations SET revoked_at = ? WHERE person_id = ? AND markaz_id = ? AND claimed_at IS NULL AND revoked_at IS NULL").bind(stamp,target.id,markazId),
        db.prepare("INSERT INTO invitations (id,markaz_id,person_id,token_hash,mode,required_email,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(invitationId,markazId,target.id,hash,mode,mode==="email-bound"?requiredEmail:null,person.id,stamp,expiresAt),
        auditChange("invitation.create",invitationId,String(target.id),{fields:["mode","expiresAt"]})
      ]);
      return NextResponse.json({ok:true,id:invitationId,token,expiresAt,mode});
    }
    if (action === "revokeInvitation") {
      if (!leader) return fail("Only Markaz leaders can revoke invitations.",403);
      const invitationId = clean(body.invitationId,80), stamp = now();
      const result = await db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND markaz_id = ? AND claimed_at IS NULL AND revoked_at IS NULL").bind(stamp,invitationId,markazId).run();
      if (!result.meta.changes) return fail("Active invitation not found.",404);
      await db.batch([
        db.prepare("UPDATE claim_requests SET status = 'denied',reviewed_by = ?,reviewed_at = ? WHERE invitation_id = ? AND markaz_id = ? AND status = 'pending'").bind(person.id,stamp,invitationId,markazId),
        auditChange("invitation.revoke",invitationId)
      ]);
      return NextResponse.json({ok:true});
    }
    if (action === "rotateJoinCode") {
      if (!leader) return fail("Only Markaz leaders can rotate the join code.",403);
      const code = newInvitationToken().slice(0,16), stamp = now();
      await db.batch([
        db.prepare("UPDATE markaz SET join_code = ? WHERE id = ?").bind(code,markazId),
        auditChange("markaz.join-code.rotate",markazId)
      ]);
      return NextResponse.json({ok:true,code,rotatedAt:stamp});
    }
    if (action === "updatePersonContact") {
      const target = await db.prepare("SELECT id,name,phone,email,auth_id FROM people WHERE id = ? AND markaz_id = ? AND merged_into_id IS NULL").bind(clean(body.personId,80),markazId).first<Row>();
      if (!target) return fail("Person not found in this Markaz.",404);
      let allowed = leader;
      if (!allowed) {
        const jamaats = (await db.prepare("SELECT j.id,j.data FROM memberships m JOIN objects j ON j.id = m.jamaat_id AND j.markaz_id = m.markaz_id AND j.kind = 'jamaat' WHERE m.person_id = ? AND m.markaz_id = ?").bind(target.id,markazId).all<Row>()).results;
        for (const jamaat of jamaats) if (await currentAmeer(jamaat)) { allowed = true; break; }
      }
      if (!allowed) return fail("Only a Markaz leader or this person's approved Jamaat Ameer can correct these details.",403);
      const expected=body.expectedPerson;
      if(!expected||typeof expected!=="object"||Array.isArray(expected)||Object.keys(expected).sort().join(",")!=="email,name,phone")return fail("Reload this person before correcting contact details.",409);
      const prior=expected as Record<string,unknown>;
      if(typeof prior.name!=="string"||prior.phone!==null&&typeof prior.phone!=="string"||prior.email!==null&&typeof prior.email!=="string")return fail("Reload this person before correcting contact details.",409);
      if(target.name!==prior.name||target.phone!==prior.phone||target.email!==prior.email)return fail("This contact changed. Reload and review it.",409);
      const name = clean(body.name,100), phone = clean(body.phone,40), email = clean(body.email,150);
      if (!name) return fail("Enter the person's name.");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Check the email address.");
      const before = {name:target.name,phone:target.phone,email:target.email}, after = {name,phone:phone||null,email:email||null}, stamp = now();
      const guardId=id();
      try{await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM people WHERE id=? AND markaz_id=? AND merged_into_id IS NULL AND name=? AND phone IS ? AND email IS ?) THEN ? ELSE 'stale' END").bind(target.id,markazId,prior.name,prior.phone,prior.email,guardId),
        db.prepare("UPDATE people SET name = ?,phone = ?,email = ? WHERE id = ? AND markaz_id = ? AND merged_into_id IS NULL AND name=? AND phone IS ? AND email IS ?").bind(name,phone||null,email||null,target.id,markazId,prior.name,prior.phone,prior.email),
        db.prepare("UPDATE invitations SET revoked_at = ? WHERE person_id = ? AND markaz_id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND ? <> ?").bind(stamp,target.id,markazId,normalizeEmail(target.email),normalizeEmail(email)),
        db.prepare("UPDATE claim_requests SET status = 'denied',reviewed_by = ?,reviewed_at = ? WHERE target_person_id = ? AND markaz_id = ? AND status = 'pending' AND ? <> ?").bind(person.id,stamp,target.id,markazId,normalizeEmail(target.email),normalizeEmail(email)),
        db.prepare("INSERT INTO person_corrections (id,markaz_id,person_id,actor_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(id(),markazId,target.id,person.id,JSON.stringify(before),JSON.stringify(after),stamp),
        auditChange("person.contact.correct",String(target.id),String(target.id),{fields:Object.keys(after).filter(field=>before[field as keyof typeof before]!==after[field as keyof typeof after])}),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId)
      ]);}catch{return fail("This contact changed. Reload and review it.",409);}
      return NextResponse.json({ok:true});
    }
    if (action === "reviewClaim") {
      if (!leader) return fail("Only Markaz leaders can review account claims.",403);
      const claim = await db.prepare("SELECT * FROM claim_requests WHERE id = ? AND markaz_id = ?").bind(clean(body.claimId,80),markazId).first<Row>();
      if (!claim) return fail("Claim request not found.",404);
      if (claim.status !== "pending") return fail("This claim has already been reviewed.",409);
      const decision = body.decision;
      if (decision !== "approve" && decision !== "deny") return fail("Choose approve or deny.");
      const invitation = await db.prepare("SELECT * FROM invitations WHERE id = ? AND markaz_id = ? AND person_id = ?").bind(claim.invitation_id,markazId,claim.target_person_id).first<Row>();
      const stamp = now();
      if (decision === "deny") {
        const denied = await db.prepare("UPDATE claim_requests SET status = 'denied',reviewed_by = ?,reviewed_at = ? WHERE id = ? AND markaz_id = ? AND status = 'pending'").bind(person.id,stamp,claim.id,markazId).run();
        if (!denied.meta.changes) return fail("This claim changed. Reload and review it again.",409);
        await db.batch([
          db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND markaz_id = ? AND claimed_at IS NULL AND revoked_at IS NULL").bind(stamp,claim.invitation_id,markazId),
          auditChange("person.claim.deny",String(claim.id),String(claim.target_person_id))
        ]);
        return NextResponse.json({ok:true});
      }
      if (!invitation || invitation.revoked_at || invitation.claimed_at || String(invitation.expires_at) <= stamp) return fail("The invitation expired or was revoked. Issue a new one after review.",410);
      const source = await db.prepare("SELECT id,auth_id,role,merged_into_id FROM people WHERE id = ? AND markaz_id = ?").bind(claim.source_person_id,markazId).first<Row>();
      const target = await db.prepare("SELECT id,auth_id,merged_into_id FROM people WHERE id = ? AND markaz_id = ?").bind(claim.target_person_id,markazId).first<Row>();
      if (!source || !target || source.auth_id !== claim.claimant_auth_id || source.role !== "worker" || source.merged_into_id || target.auth_id || target.merged_into_id) return fail("One account changed. Reload before approving.",409);
      const overlap = await db.prepare("SELECT 1 FROM memberships s JOIN memberships t ON t.jamaat_id = s.jamaat_id AND t.markaz_id = s.markaz_id WHERE s.person_id = ? AND t.person_id = ? AND s.markaz_id = ? LIMIT 1").bind(source.id,target.id,markazId).first<Row>();
      if (overlap) return fail("Both records belong to one Jamaat. Review the conflicting memberships before merging.",409);
      const linkedObjects = (await db.prepare("SELECT id,data,created_by FROM objects WHERE markaz_id = ?").bind(markazId).all<Row>()).results;
      const linkedSeries=(await db.prepare("SELECT id,template_data,created_by,version FROM mashwara_series WHERE markaz_id=?").bind(markazId).all<Row>()).results;
      const linkedSegments=(await db.prepare("SELECT c.id,c.series_id,c.template_data FROM mashwara_series_changes c JOIN mashwara_series s ON s.id=c.series_id WHERE s.markaz_id=?").bind(markazId).all<Row>()).results;
      const changes = [
        db.prepare("UPDATE people SET auth_id = NULL,merged_into_id = ? WHERE id = ? AND markaz_id = ? AND auth_id = ? AND merged_into_id IS NULL AND EXISTS (SELECT 1 FROM claim_requests WHERE id = ? AND status = 'pending')").bind(target.id,source.id,markazId,source.auth_id,claim.id),
        db.prepare("UPDATE people SET auth_id = ? WHERE id = ? AND markaz_id = ? AND auth_id IS NULL AND merged_into_id IS NULL AND EXISTS (SELECT 1 FROM people WHERE id = ? AND merged_into_id = ?) AND EXISTS (SELECT 1 FROM invitations WHERE id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?)").bind(source.auth_id,target.id,markazId,source.id,target.id,invitation.id,stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 AND EXISTS (SELECT 1 FROM claim_requests WHERE id = ? AND status = 'pending') THEN 'person.claim.merge' ELSE NULL END,?,?,?,?)").bind(id(),markazId,person.id,claim.id,target.id,target.id,JSON.stringify({fields:["identity-link","membership-references"]}),stamp),
        db.prepare("UPDATE memberships SET person_id = ? WHERE person_id = ? AND markaz_id = ?").bind(target.id,source.id,markazId)
      ];
      for (const row of linkedObjects) {
        const original = String(row.data), parsed = data(row.data), updated = JSON.stringify(replacePersonReferences(parsed,String(source.id),String(target.id)));
        const savedData = updated === JSON.stringify(parsed) ? original : updated;
        const createdBy = row.created_by === source.id ? target.id : row.created_by;
        if (savedData === original && createdBy === row.created_by) continue;
        changes.push(
          db.prepare("UPDATE objects SET data = ?,created_by = ?,updated_at=? WHERE id = ? AND markaz_id = ? AND data = ? AND created_by = ?").bind(savedData,createdBy,stamp,row.id,markazId,original,row.created_by),
          db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 THEN 'person.claim.reference' ELSE NULL END,?,?,?,?)").bind(id(),markazId,person.id,row.id,target.id,"{}",stamp)
        );
      }
      for(const row of linkedSeries){
        const original=String(row.template_data),parsed=data(original),updated=JSON.stringify(replacePersonReferences(parsed,String(source.id),String(target.id)));
        const saved=updated===JSON.stringify(parsed)?original:updated,creator=row.created_by===source.id?target.id:row.created_by;
        if(saved===original&&creator===row.created_by)continue;
        changes.push(db.prepare("UPDATE mashwara_series SET template_data=?,created_by=?,version=?,updated_at=? WHERE id=? AND markaz_id=? AND template_data=? AND created_by=? AND version=?").bind(saved,creator,id(),stamp,row.id,markazId,original,row.created_by,row.version),db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes()=1 THEN 'person.claim.series-reference' ELSE NULL END,?,?,?,?)").bind(id(),markazId,person.id,row.id,target.id,"{}",stamp));
      }
      for(const row of linkedSegments){
        const original=String(row.template_data),parsed=data(original),updated=JSON.stringify(replacePersonReferences(parsed,String(source.id),String(target.id)));
        if(updated===JSON.stringify(parsed))continue;
        changes.push(db.prepare("UPDATE mashwara_series_changes SET template_data=? WHERE id=? AND series_id=? AND template_data=?").bind(updated,row.id,row.series_id,original),db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes()=1 THEN 'person.claim.series-reference' ELSE NULL END,?,?,?,?)").bind(id(),markazId,person.id,row.id,target.id,"{}",stamp),db.prepare("UPDATE mashwara_series SET version=?,updated_at=? WHERE id=? AND markaz_id=?").bind(id(),stamp,row.series_id,markazId));
      }
      changes.push(
        db.prepare("INSERT OR IGNORE INTO mashwara_series_collaborators (series_id,person_id,created_at) SELECT c.series_id,?,c.created_at FROM mashwara_series_collaborators c JOIN mashwara_series s ON s.id=c.series_id WHERE c.person_id=? AND s.markaz_id=?").bind(target.id,source.id,markazId),
        db.prepare("DELETE FROM mashwara_series_collaborators WHERE person_id=? AND series_id IN (SELECT id FROM mashwara_series WHERE markaz_id=?)").bind(source.id,markazId),
        db.prepare("UPDATE mashwara_umoor_templates SET created_by=? WHERE created_by=? AND series_id IN (SELECT id FROM mashwara_series WHERE markaz_id=?)").bind(target.id,source.id,markazId),
        db.prepare("UPDATE person_corrections SET person_id=? WHERE person_id=? AND markaz_id=?").bind(target.id,source.id,markazId)
      );
      changes.push(
        db.prepare("UPDATE invitations SET claimed_at = ?,claimed_auth_id = ? WHERE id = ? AND markaz_id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(stamp,source.auth_id,invitation.id,markazId,stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 THEN 'person.claim.invitation' ELSE NULL END,?,?,?,?)").bind(id(),markazId,person.id,invitation.id,target.id,"{}",stamp),
        db.prepare("UPDATE claim_requests SET status = 'approved',reviewed_by = ?,reviewed_at = ? WHERE id = ? AND markaz_id = ? AND status = 'pending'").bind(person.id,stamp,claim.id,markazId),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 THEN 'person.claim.reviewed' ELSE NULL END,?,?,?,?)").bind(id(),markazId,person.id,claim.id,target.id,"{}",stamp)
      );
      try { await db.batch(changes); }
      catch { return fail("The account changed during review. Reload and try again.",409); }
      return NextResponse.json({ok:true,merged:true});
    }
    const canPlanMashwara = async (m: Row) => {
      if (data(m.data).daily === true) {
        const jamaat = await object(m.parent_id);
        if (!jamaat || jamaat.kind !== "jamaat") return false;
        if (await hasJamaatScope(jamaat,"amaal")) return true;
        const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(jamaat.id,person.id,markazId).first<Row>();
        if (!member) return false;
        if (data(m.data).ameerId === person.id) return true;
        const planner = await db.prepare("SELECT id FROM objects WHERE kind = 'collaborator' AND status <> 'removed' AND parent_id = ? AND markaz_id = ? AND json_extract(data,'$.personId') = ?").bind(m.id,markazId,person.id).first<Row>();
        return !!planner;
      }
      if (leader || m.created_by === person.id || data(m.data).ameerId === person.id) return true;
      const c = await db.prepare("SELECT id FROM objects WHERE kind = 'collaborator' AND status <> 'removed' AND parent_id = ? AND json_extract(data,'$.personId') = ?").bind(m.id,person.id).first<Row>();
      if(c)return true;
      const seriesId=clean(data(m.data).seriesId,80);
      return !!seriesId&&!!(await db.prepare("SELECT 1 FROM mashwara_series_collaborators c JOIN mashwara_series s ON s.id=c.series_id WHERE c.series_id=? AND c.person_id=? AND s.markaz_id=?").bind(seriesId,person.id,markazId).first<Row>());
    };
    if (action === "addPerson") {
      if (!leader && !(await leadsApprovedJamaat())) return fail("Only Markaz leaders and approved Ameers can add people.",403);
      const name = clean(body.name,100), phone = clean(body.phone,40), email = clean(body.email,150);
      if (!name) return fail("Enter a name.");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Check the email address.");
      const pid = id();
      try { await db.batch([
        guardedGlobalAudit("person.add",pid),
        db.prepare("INSERT INTO people (id,markaz_id,name,phone,email,created_at) VALUES (?,?,?,?,?,?)").bind(pid,markazId,name,phone||null,email||null,now())
      ]); }
      catch { return fail("Your person-creation authority changed. Reload and try again.",409); }
      return NextResponse.json({ ok:true, id:pid });
    }
    if (action === "addDraftPerson") {
      const jamaat = await object(body.jamaatId);
      if (!jamaat || jamaat.kind !== "jamaat") return fail("Draft Jamaat not found.",404);
      const details = data(jamaat.data);
      const ownDraft = jamaat.created_by === person.id && ["pending","declined"].includes(String(details.ameerStatus)) && !details.ameerId
        && !!(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(jamaat.id,person.id,markazId).first<Row>());
      if (!ownDraft) return fail("Only the current creator can add a new person to this pending draft.",403);
      if (typeof body.name !== "string" || body.name.trim().length>100 || typeof body.phone !== "undefined" && typeof body.phone !== "string" || typeof body.email !== "undefined" && typeof body.email !== "string") return fail("Check the person's details.");
      const name=clean(body.name,100),phone=clean(body.phone,40),email=clean(body.email,150);
      if (!name || String(body.phone||"").trim().length>40 || String(body.email||"").trim().length>150 || email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Check the person's details.");
      const pid=id(),stamp=now();
      try { await db.batch([
        db.prepare("INSERT INTO people (id,markaz_id,name,phone,email,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM objects j JOIN memberships m ON m.jamaat_id = j.id AND m.person_id = ? AND m.markaz_id = j.markaz_id WHERE j.id = ? AND j.markaz_id = ? AND j.kind = 'jamaat' AND j.created_by = ? AND json_extract(j.data,'$.ameerStatus') IN ('pending','declined') AND json_extract(j.data,'$.ameerId') IS NULL)").bind(pid,markazId,name,phone||null,email||null,stamp,person.id,jamaat.id,markazId,person.id),
        db.prepare("INSERT INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM people WHERE id = ? AND markaz_id = ?)").bind(id(),markazId,jamaat.id,pid,"member",stamp,pid,markazId),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,created_at) VALUES (?,?,?,CASE WHEN changes() = 1 THEN 'draft.person.add' ELSE NULL END,?,?)").bind(id(),markazId,person.id,pid,stamp)
      ]); }
      catch { return fail("This draft changed while saving. Reload it and try again.",409); }
      return NextResponse.json({ok:true,id:pid});
    }
    if (action === "importPeople") {
      const jamaatId=clean(body.jamaatId,80);
      const jamaat=jamaatId?await object(jamaatId):null;
      if (jamaatId && (!jamaat || jamaat.kind!=="jamaat")) return fail("Jamaat not found.",404);
      const details=jamaat?data(jamaat.data):{};
      const ownDraft=!!jamaat && jamaat.created_by===person.id && ["pending","declined"].includes(String(details.ameerStatus)) && !details.ameerId
        && !!(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(jamaat.id,person.id,markazId).first<Row>());
      const led = await db.prepare("SELECT j.id FROM objects j JOIN memberships m ON m.jamaat_id = j.id AND m.person_id = ? AND m.markaz_id = j.markaz_id WHERE j.markaz_id = ? AND j.kind = 'jamaat' AND json_extract(j.data,'$.ameerStatus') = 'approved' AND json_extract(j.data,'$.ameerId') = ? LIMIT 1").bind(person.id,markazId,person.id).first<Row>();
      if (!(leader || ownDraft || led && (!jamaat || await currentAmeer(jamaat)))) return fail("Only a Markaz leader, approved Ameer, or this draft's creator can import here.",403);
      if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500) return fail("Choose 1 to 500 rows at a time.");
      const dedupeScope = "(? = 1 OR p.id = ? OR EXISTS (SELECT 1 FROM audit a WHERE a.markaz_id = p.markaz_id AND a.actor_id = ? AND a.object_id = p.id AND a.action IN ('person.add','draft.person.add','people.import.row')))";
      const existing = (await db.prepare(`SELECT p.name,p.phone,p.email FROM people p WHERE p.markaz_id = ? AND p.merged_into_id IS NULL AND ${dedupeScope}`).bind(markazId,leader?1:0,person.id,person.id).all<Row>()).results;
      const keys = new Set(existing.map(p => candidateKey({name:String(p.name),phone:String(p.phone||""),email:String(p.email||"")})));
      const results:{rowNumber:number;status:"added"|"duplicate"|"rejected";reason?:string;id?:string}[]=[];
      const pending:{resultIndex:number;statementIndex:number;id:string}[]=[];
      const stamp=now();
      const scopePredicate=jamaat
        ? "EXISTS (SELECT 1 FROM objects j JOIN memberships m ON m.jamaat_id = j.id AND m.person_id = ? AND m.markaz_id = j.markaz_id WHERE j.id = ? AND j.markaz_id = ? AND j.kind = 'jamaat' AND ((j.created_by = ? AND json_extract(j.data,'$.ameerStatus') IN ('pending','declined') AND json_extract(j.data,'$.ameerId') IS NULL) OR (json_extract(j.data,'$.ameerStatus') = 'approved' AND json_extract(j.data,'$.ameerId') = ?)))"
        : "EXISTS (SELECT 1 FROM objects j JOIN memberships m ON m.jamaat_id = j.id AND m.person_id = ? AND m.markaz_id = j.markaz_id WHERE j.markaz_id = ? AND j.kind = 'jamaat' AND json_extract(j.data,'$.ameerStatus') = 'approved' AND json_extract(j.data,'$.ameerId') = ?)";
      const authority=`EXISTS (SELECT 1 FROM people actor WHERE actor.id = ? AND actor.markaz_id = ? AND actor.role IN ('admin','markaz_ameer')) OR ${scopePredicate}`;
      const authorityBindings=jamaat?[person.id,markazId,person.id,jamaat.id,markazId,person.id,person.id]:[person.id,markazId,person.id,markazId,person.id];
      const statements=[db.prepare(`INSERT INTO audit (id,markaz_id,actor_id,action,object_id,created_at) VALUES (?,?,?,CASE WHEN ${authority} THEN 'people.import' ELSE NULL END,?,?)`).bind(id(),markazId,person.id,...authorityBindings,jamaat?.id||null,stamp)];
      for (let index=0;index<body.rows.length;index++) {
        const entry=body.rows[index],rowNumber=entry&&typeof entry==="object"&&Number.isInteger((entry as Row).rowNumber)&&(entry as Row).rowNumber as number||index+1;
        if (!entry || typeof entry!=="object" || Array.isArray(entry)) {results.push({rowNumber,status:"rejected",reason:"Row must contain name and optional contact fields."});continue;}
        const row=entry as Row;
        if (typeof row.name!=="string" || row.phone!=null&&typeof row.phone!=="string" || row.email!=null&&typeof row.email!=="string") {results.push({rowNumber,status:"rejected",reason:"Check the row values."});continue;}
        const name=row.name.trim(),phone=String(row.phone||"").trim(),email=String(row.email||"").trim();
        const reason=!name?"Name is required.":name.length>100?"Name is over 100 characters.":phone.length>40?"Phone is over 40 characters.":email.length>150?"Email is over 150 characters.":email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?"Email address is invalid.":"";
        if (reason) {results.push({rowNumber,status:"rejected",reason});continue;}
        const key=candidateKey({name,phone,email});
        if (keys.has(key)) {results.push({rowNumber,status:"duplicate",reason:"Exact name and contact details already exist."});continue;}
        keys.add(key);
        const pid=id(),resultIndex=results.length,statementIndex=statements.length;
        results.push({rowNumber,status:"rejected",reason:"The row could not be saved."});
        statements.push(db.prepare(`INSERT INTO people (id,markaz_id,name,phone,email,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.markaz_id = ? AND p.merged_into_id IS NULL AND lower(trim(p.name)) = ? AND COALESCE(p.phone,'') = ? AND lower(COALESCE(p.email,'')) = ? AND ${dedupeScope})`).bind(pid,markazId,name,phone||null,email||null,stamp,markazId,name.toLowerCase(),phone,email.toLowerCase(),leader?1:0,person.id,person.id));
        statements.push(db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM people WHERE id = ? AND markaz_id = ?)").bind(id(),markazId,person.id,"people.import.row",pid,stamp,pid,markazId));
        if (jamaat) statements.push(db.prepare("INSERT INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM people WHERE id = ? AND markaz_id = ?)").bind(id(),markazId,jamaat.id,pid,"member",stamp,pid,markazId));
        pending.push({resultIndex,statementIndex,id:pid});
      }
      if(pending.length) {
        let writes;
        try {writes=await db.batch(statements);}
        catch { return fail("Import authority or data changed. Reload and review the rows again.",409); }
        for(const entry of pending) results[entry.resultIndex]=writes[entry.statementIndex].meta.changes?{rowNumber:results[entry.resultIndex].rowNumber,status:"added",id:entry.id}:{rowNumber:results[entry.resultIndex].rowNumber,status:"duplicate",reason:"An exact record was already saved."};
      }
      const added=results.filter(row=>row.status==="added").length,duplicate=results.filter(row=>row.status==="duplicate").length,rejected=results.filter(row=>row.status==="rejected").length;
      return NextResponse.json({ok:true,added,duplicate,rejected,skipped:duplicate+rejected,results});
    }
    if(action==="archivePlace" || action==="mergePlaces") {
      if(!leader)return fail("Only Markaz leaders can review places.",403);
      const source=await object(body.sourceId);
      if(!source||source.kind!=="place")return fail("Place not found.",404);
      if(source.status==="archived")return fail("This place is already archived.",409);
      if(body.expectedSourceUpdatedAt!==source.updated_at)return fail("The place changed. Reload before reviewing it.",409);
      const reason=clean(body.reason,500);
      if(reason.length<5)return fail("Explain the place review in at least five characters.");
      const target=action==="mergePlaces"?await object(body.targetId):null;
      if(action==="mergePlaces"&&(!target||target.kind!=="place"||target.id===source.id||target.status==="archived"))return fail("Choose a different active place in this Markaz.");
      if(target&&body.expectedTargetUpdatedAt!==target.updated_at)return fail("The destination place changed. Reload before merging.",409);
      const refs=(await db.prepare("SELECT id,kind FROM objects WHERE markaz_id=? AND id<>? AND (parent_id=? OR (json_valid(data) AND (json_extract(data,'$.placeId')=? OR json_extract(data,'$.locationId')=?)))").bind(markazId,source.id,source.id,source.id,source.id).all<Row>()).results;
      const profileRefs=await db.prepare("SELECT COUNT(*) AS n FROM people WHERE markaz_id=? AND (local_masjid_id=? OR local_markaz_id=? OR national_markaz_id=?)").bind(markazId,source.id,source.id,source.id).first<{n:number}>();
      if(action==="archivePlace"&&(refs.length||Number(profileRefs?.n||0)))return NextResponse.json({error:"This place is linked to routes, notes, meetings or profiles. Merge it into an active place before archiving.",links:refs.length,profiles:Number(profileRefs?.n||0)},{status:409});
      const stamp=nextStamp(source.updated_at),guardId=id();
      const sourceData=data(source.data);
      const sourceUpdate={...sourceData,archivedAt:stamp,archiveReason:reason,...(target?{mergedIntoId:target.id}:{})};
      const statements=[db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM objects WHERE id=? AND markaz_id=? AND kind='place' AND status<>'archived' AND updated_at=?) AND (?=0 OR EXISTS (SELECT 1 FROM objects WHERE id=? AND markaz_id=? AND kind='place' AND status<>'archived' AND updated_at=?)) AND (?=1 OR (NOT EXISTS (SELECT 1 FROM objects WHERE markaz_id=? AND id<>? AND (parent_id=? OR (json_valid(data) AND (json_extract(data,'$.placeId')=? OR json_extract(data,'$.locationId')=?)))) AND NOT EXISTS (SELECT 1 FROM people WHERE markaz_id=? AND (local_masjid_id=? OR local_markaz_id=? OR national_markaz_id=?)))) THEN ? ELSE 'stale' END").bind(source.id,markazId,source.updated_at,target?1:0,target?.id||"",markazId,target?.updated_at||"",target?1:0,markazId,source.id,source.id,source.id,source.id,markazId,source.id,source.id,source.id,guardId)];
      if(target){
        const targetData=data(target.data),ids=[...new Set([...(Array.isArray(targetData.osmIds)?targetData.osmIds:[]),targetData.osmId,...(Array.isArray(sourceData.osmIds)?sourceData.osmIds:[]),sourceData.osmId].filter((value):value is string=>typeof value==="string"&&!!value))];
        statements.push(db.prepare("UPDATE objects SET data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(JSON.stringify({...targetData,osmIds:ids,mergedSourceIds:[...new Set([...(Array.isArray(targetData.mergedSourceIds)?targetData.mergedSourceIds:[]),source.id])]}),nextStamp(target.updated_at),target.id,markazId));
        statements.push(db.prepare("UPDATE objects SET parent_id=?,updated_at=? WHERE markaz_id=? AND parent_id=?").bind(target.id,stamp,markazId,source.id));
        for(const key of ["placeId","locationId"])statements.push(db.prepare(`UPDATE objects SET data=json_set(data,'$.${key}',?),updated_at=? WHERE markaz_id=? AND json_valid(data) AND json_extract(data,'$.${key}')=?`).bind(target.id,stamp,markazId,source.id));
        statements.push(db.prepare("UPDATE people SET local_masjid_id=? WHERE markaz_id=? AND local_masjid_id=?").bind(target.id,markazId,source.id));
        statements.push(db.prepare("UPDATE people SET local_markaz_id=? WHERE markaz_id=? AND local_markaz_id=?").bind(target.id,markazId,source.id));
        statements.push(db.prepare("UPDATE people SET national_markaz_id=? WHERE markaz_id=? AND national_markaz_id=?").bind(target.id,markazId,source.id));
      }
      statements.push(db.prepare("UPDATE objects SET status='archived',data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(JSON.stringify(sourceUpdate),stamp,source.id,markazId));
      statements.push(db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange(target?"place.merge":"place.archive",String(source.id)));
      try{await db.batch(statements);}catch{return fail("Place links or versions changed. Reload and review the merge.",409);}
      return NextResponse.json({ok:true,sourceId:source.id,targetId:target?.id||null,linksMoved:target?refs.length:0});
    }
    if (action === "addOsmPlace") {
      if (!leader) return fail("Only Markaz leaders can add directory places.",403);
      const osmId=clean(body.osmId,80);
      if(!/^(node|way|relation)\/\d+$/.test(osmId))return fail("Choose a directory result.");
      const candidate=await db.prepare("SELECT data_json,state,checked_at FROM directory_candidates WHERE osm_id=? AND expires_at>?").bind(osmId,now()).first<Row>();
      if(!candidate)return fail("This result was not checked by the server recently. Refresh the directory.",409);
      const selected=JSON.parse(String(candidate.data_json)) as DirectoryPlace;
      if(!surreyArea(selected.lat,selected.lon)||outsideSurreyAddress(selected.address))return fail("Place is outside the Surrey area.");
      const type=body.type===undefined?selected.type:body.type;
      if(!["masjid","musalla","centre","markaz"].includes(String(type)))return fail("Choose a valid venue type.");
      if(body.allowPotentialDuplicate!==undefined&&typeof body.allowPotentialDuplicate!=="boolean")return fail("Invalid duplicate review choice.");
      const existing=(await db.prepare("SELECT id,title,status,data FROM objects WHERE markaz_id=? AND kind='place'").bind(markazId).all<Row>()).results.filter(row=>row.status!=="archived");
      if(existing.some(row=>selected.osmIds.some(osm=>String(data(row.data).osmId)===osm||Array.isArray(data(row.data).osmIds)&&(data(row.data).osmIds as unknown[]).includes(osm))))return fail("This OpenStreetMap place is already imported.",409);
      const duplicates=existing.filter(row=>potentialDuplicate({name:selected.name,address:selected.address,lat:selected.lat,lon:selected.lon},{name:String(row.title),address:String(data(row.data).address||""),lat:Number(data(row.data).lat)||undefined,lon:Number(data(row.data).lon)||undefined})).map(row=>({id:row.id,title:row.title}));
      if(duplicates.length&&body.allowPotentialDuplicate!==true)return NextResponse.json({error:"A possible duplicate exists. Review it before importing another place.",duplicates},{status:409});
      const oid = id(), stamp = now();
      const fields = { type:type as VenueType, address:selected.address, source:"OpenStreetMap", provenance:candidate.state==="snapshot"?"snapshot-unverified":"server-checked", sourceState:candidate.state, checkedAt:candidate.checked_at, osmId:selected.osmId, osmIds:selected.osmIds, lat:selected.lat, lon:selected.lon, hostPermission:"unknown", notes:"" };
      const guardId=id();
      try{await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM objects WHERE markaz_id=? AND kind='place' AND status<>'archived' AND json_valid(data) AND (json_extract(data,'$.osmId') IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(data,'$.osmIds') WHERE value IN (SELECT value FROM json_each(?))))) THEN ? ELSE 'stale' END").bind(markazId,JSON.stringify(selected.osmIds),JSON.stringify(selected.osmIds),guardId),
        db.prepare("INSERT INTO objects (id,markaz_id,kind,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(oid,markazId,"place",selected.name,"active",JSON.stringify(fields),person.id,stamp,stamp),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("place.import",oid)
      ]);}catch{return fail("This place was imported while saving. Reload the directory.",409);}
      return NextResponse.json({ ok:true, id:oid });
    }
    if (action === "createJamaat") {
      const input = createJamaatInput(body);
      const {title,start,end,kind,route,selfAmeer} = input;
      const selected = input.ameerId;
      if (selected && !leader) return fail("Only a Markaz leader may appoint another Ameer.",403);
      if (selected && !(await personInMarkaz(selected))) return fail("Choose a person from this Markaz.");
      const jd = { kind, route, timeZone:markazZone, ameerId:selected||null, ameerStatus:selected?"approved":selfAmeer?"pending":"unassigned", pendingAmeerId:selected?null:selfAmeer?person.id:null };
      const jid = id(), stamp = now();
      const changes = [
        db.prepare("INSERT INTO objects (id,markaz_id,kind,title,start_at,end_at,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(jid,markazId,"jamaat",title,start,end,"planning",JSON.stringify(jd),person.id,stamp,stamp),
        db.prepare("INSERT INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) VALUES (?,?,?,?,?,?)").bind(id(),markazId,jid,person.id,selected===person.id?"ameer":"member",stamp),
      ];
      if (selected && selected !== person.id) changes.push(db.prepare("INSERT INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) VALUES (?,?,?,?,?,?)").bind(id(),markazId,jid,selected,"ameer",stamp));
      if (selected || selfAmeer) changes.push(ameerDecision(jid,selected?"approved":"requested",selected||String(person.id),null));
      changes.push(auditChange("jamaat.create",jid));
      await db.batch(changes);
      return NextResponse.json({ ok:true, id:jid, ameerStatus:jd.ameerStatus });
    }
    if (action === "requestAmeer") {
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      if (j.created_by !== person.id) return fail("Only the creator can request to lead this Jamaat.",403);
      const jd = data(j.data);
      if (jd.ameerStatus === "approved") return fail("This Jamaat already has an Ameer.");
      if (jd.ameerStatus === "pending" && jd.pendingAmeerId === person.id) return NextResponse.json({ ok:true, existing:true });
      await db.batch([
        db.prepare("INSERT INTO ameer_decisions (id,markaz_id,jamaat_id,actor_id,action,subject_id,previous_ameer_id,created_at) SELECT ?,?,?,?,?,?,NULL,? FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND COALESCE(json_extract(data,'$.ameerStatus'),'') <> 'approved'").bind(id(),markazId,j.id,person.id,"requested",person.id,now(),j.id,markazId),
        db.prepare("UPDATE objects SET data = json_set(data,'$.pendingAmeerId',?,'$.ameerStatus','pending'), updated_at = ? WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND COALESCE(json_extract(data,'$.ameerStatus'),'') <> 'approved'").bind(person.id,now(),j.id,markazId),
        db.prepare("INSERT OR IGNORE INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) VALUES (?,?,?,?,?,?)").bind(id(),markazId,j.id,person.id,"member",now()),
        auditChange("ameer.request",String(j.id),String(person.id),{previousStatus:String(jd.ameerStatus||"none"),nextStatus:"pending"})
      ]);
      const current = await object(j.id);
      if (data(current?.data).ameerStatus !== "pending") return fail("This Jamaat already has an Ameer.",409);
      return NextResponse.json({ ok:true });
    }
    if (action === "appointAmeer") {
      if (!leader) return fail("Only a Markaz leader can approve or appoint an Ameer.",403);
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      const selected = clean(body.personId,80);
      if (!selected || !(await personInMarkaz(selected))) return fail("Choose a person from this Markaz.");
      const jd = data(j.data);
      const creatorMembership = await db.prepare("SELECT permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,j.created_by,markazId).first<Row>();
      const previousMembership = jd.ameerId && jd.ameerId !== j.created_by ? await db.prepare("SELECT permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,jd.ameerId,markazId).first<Row>() : null;
      const oldGrants = [[j.created_by,creatorMembership],[jd.ameerId,previousMembership]] as const;
      const changes = [
        db.prepare("INSERT INTO ameer_decisions (id,markaz_id,jamaat_id,actor_id,action,subject_id,previous_ameer_id,created_at) SELECT ?,markaz_id,id,?,CASE WHEN json_extract(data,'$.ameerStatus') = 'approved' AND json_extract(data,'$.ameerId') <> ? THEN 'replaced' WHEN json_extract(data,'$.ameerStatus') = 'pending' AND json_extract(data,'$.pendingAmeerId') <> ? THEN 'substituted' ELSE 'approved' END,?,CASE WHEN json_extract(data,'$.ameerStatus') = 'approved' THEN json_extract(data,'$.ameerId') ELSE NULL END,? FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND (COALESCE(json_extract(data,'$.ameerStatus'),'') <> 'approved' OR COALESCE(json_extract(data,'$.ameerId'),'') <> ?)").bind(id(),person.id,selected,selected,selected,now(),j.id,markazId,selected),
        db.prepare("UPDATE objects SET data = json_set(data,'$.ameerId',?,'$.ameerStatus','approved','$.pendingAmeerId',NULL), updated_at = ? WHERE id = ? AND markaz_id = ? AND kind = 'jamaat'").bind(selected,now(),j.id,markazId),
        db.prepare("UPDATE memberships SET role = 'member' WHERE jamaat_id = ? AND markaz_id = ?").bind(j.id,markazId),
        db.prepare("INSERT OR IGNORE INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) VALUES (?,?,?,?,?,?)").bind(id(),markazId,j.id,selected,"member",now()),
        db.prepare("UPDATE memberships SET role = 'ameer' WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,selected,markazId),
      ];
      for (const [memberId,membership] of oldGrants) {
        if (!memberId || !membership) continue;
        const original=String(membership.permissions), permissions=data(original);
        if (needsLegacyGrantReview(permissions)) changes.push(db.prepare("UPDATE memberships SET permissions = ? WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ? AND permissions = ?").bind(JSON.stringify(revokeUnverifiedGrant(permissions)),j.id,memberId,markazId,original));
      }
      changes.push(auditChange("ameer.appoint",String(j.id),selected,{previousStatus:String(jd.ameerStatus||"none"),nextStatus:"approved"}));
      await db.batch(changes);
      return NextResponse.json({ ok:true });
    }
    if (action === "declineAmeer") {
      if (!leader) return fail("Only a Markaz leader can review Ameer requests.",403);
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      const jd = data(j.data);
      if (jd.ameerStatus === "declined") return NextResponse.json({ ok:true, existing:true });
      if (jd.ameerStatus !== "pending" || !jd.pendingAmeerId) return fail("There is no pending Ameer request.");
      const membership = await db.prepare("SELECT permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,jd.pendingAmeerId,markazId).first<Row>();
      const changes = [
        db.prepare("INSERT INTO ameer_decisions (id,markaz_id,jamaat_id,actor_id,action,subject_id,previous_ameer_id,created_at) SELECT ?,markaz_id,id,?,'declined',?,NULL,? FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND json_extract(data,'$.ameerStatus') = 'pending'").bind(id(),person.id,jd.pendingAmeerId,now(),j.id,markazId),
        db.prepare("UPDATE objects SET data = json_set(data,'$.pendingAmeerId',NULL,'$.ameerId',NULL,'$.ameerStatus','declined'), updated_at = ? WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND json_extract(data,'$.ameerStatus') = 'pending'").bind(now(),j.id,markazId),
        db.prepare("UPDATE memberships SET role = 'member' WHERE jamaat_id = ? AND markaz_id = ? AND EXISTS (SELECT 1 FROM objects WHERE id = ? AND markaz_id = ? AND json_extract(data,'$.ameerStatus') = 'declined')").bind(j.id,markazId,j.id,markazId),
      ];
      if (membership && needsLegacyGrantReview(data(membership.permissions))) changes.push(db.prepare("UPDATE memberships SET permissions = ? WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ? AND permissions = ?").bind(JSON.stringify(revokeUnverifiedGrant(data(membership.permissions))),j.id,jd.pendingAmeerId,markazId,String(membership.permissions)));
      changes.push(auditChange("ameer.decline",String(j.id),String(jd.pendingAmeerId),{previousStatus:"pending",nextStatus:"declined"}));
      await db.batch(changes);
      const current = await object(j.id);
      if (data(current?.data).ameerStatus !== "declined") return fail("This request has already been reviewed.",409);
      return NextResponse.json({ ok:true });
    }
    if (action === "setMarkazRole") {
      if (person.role !== "admin") return fail("Only a Markaz admin can set Markaz roles.",403);
      const selected = await personInMarkaz(body.personId);
      if (!selected) return fail("Person not found.",404);
      if (selected.id === person.id) return fail("You cannot change your own admin role.");
      const role = body.role === "markaz_ameer" ? "markaz_ameer" : "worker";
      await db.batch([
        db.prepare("UPDATE people SET role = ? WHERE id = ?").bind(role,selected.id),
        auditChange("markaz.role",String(selected.id),String(selected.id),{previousRole:selected.role,nextRole:role})
      ]);
      return NextResponse.json({ ok:true });
    }
    if (action === "addMember") {
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      if (!(await hasJamaatScope(j,"roster"))) return fail("You cannot manage this Jamaat roster.",403);
      const selected = await personInMarkaz(body.personId);
      if (!selected) return fail("Person not found in this Markaz.");
      const memberId=id(),stamp=now();
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO memberships (id,markaz_id,jamaat_id,person_id,role,created_at) VALUES (?,?,?,?,?,?)").bind(memberId,markazId,j.id,selected.id,"member",stamp),
        db.prepare("INSERT INTO audit (id,markaz_id,actor_id,action,object_id,subject_id,summary_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1").bind(id(),markazId,person.id,"member.add",String(j.id),String(selected.id),JSON.stringify({membershipId:memberId}),stamp)
      ]);
      return NextResponse.json({ ok:true });
    }
    if (action === "setMemberPermission") {
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      if (!(leader || await currentAmeer(j))) return fail("Only an approved Ameer or Markaz leadership can assign permissions.",403);
      const selected = await personInMarkaz(body.personId);
      if (!selected) return fail("Person not found in this Markaz.");
      if (selected.id === person.id) return fail("You cannot grant permissions to yourself.",403);
      const membership = await db.prepare("SELECT id,permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,selected.id,markazId).first<Row>();
      if (!membership) return fail("Add this person to the Jamaat first.");
      const labels = clean(body.labels,200).split(",").map(s => s.trim()).filter(Boolean).slice(0,6).map(s => s.slice(0,40));
      const perms = permissionFields(requestedScopes(body),labels,String(person.id),leader?"markaz-leader":"approved-ameer",now());
      const result = await db.prepare("UPDATE memberships SET permissions = ? WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ? AND (? = 1 OR (EXISTS (SELECT 1 FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND json_extract(data,'$.ameerStatus') = 'approved' AND json_extract(data,'$.ameerId') = ?) AND EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?)))").bind(JSON.stringify(perms),j.id,selected.id,markazId,leader?1:0,j.id,markazId,person.id,j.id,person.id,markazId).run();
      if (!result.meta.changes) return fail("Ameer authority changed. Reload and try again.",409);
      await db.batch([
        db.prepare("UPDATE repair_reviews SET status = ? WHERE kind = 'legacy-grant' AND target_id = ? AND markaz_id = ? AND status = 'needs-review'").bind(perms.scopes.length?"replaced-with-scoped-grant":"reviewed-and-revoked",membership.id,markazId),
        auditChange("member.permission",String(j.id),String(selected.id),{membershipId:String(membership.id),previousScopes:requestedScopes(data(membership.permissions)),nextScopes:perms.scopes})
      ]);
      return NextResponse.json({ ok:true });
    }
    if (action === "revokeMemberPermissions") {
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      if (!(leader || await currentAmeer(j))) return fail("Only an approved Ameer or Markaz leadership can revoke permissions.",403);
      const selected = await personInMarkaz(body.personId);
      if (!selected) return fail("Person not found.",404);
      if (selected.id === data(j.data).ameerId) return fail("Replace this Ameer before changing their authority.",409);
      const membership = await db.prepare("SELECT id,permissions FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,selected.id,markazId).first<Row>();
      if (!membership) return fail("This person is not in the Jamaat.",404);
      const oldLabels = data(membership.permissions).labels;
      const labels = Array.isArray(oldLabels) ? oldLabels.filter((value:unknown):value is string=>typeof value==="string").slice(0,6) : [];
      const perms = permissionFields([],labels,String(person.id),leader?"markaz-leader":"approved-ameer",now());
      const revoked = await db.prepare("UPDATE memberships SET permissions = ? WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ? AND (? = 1 OR (EXISTS (SELECT 1 FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND json_extract(data,'$.ameerStatus') = 'approved' AND json_extract(data,'$.ameerId') = ?) AND EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?)))").bind(JSON.stringify(perms),j.id,selected.id,markazId,leader?1:0,j.id,markazId,person.id,j.id,person.id,markazId).run();
      if (!revoked.meta.changes) return fail("Ameer authority or membership changed. Reload and try again.",409);
      await db.batch([
        db.prepare("UPDATE repair_reviews SET status = 'reviewed-and-revoked' WHERE kind = 'legacy-grant' AND target_id = ? AND markaz_id = ? AND status = 'needs-review'").bind(membership.id,markazId),
        auditChange("member.permission.revoke",String(j.id),String(selected.id),{membershipId:String(membership.id),previousScopes:requestedScopes(data(membership.permissions)),nextScopes:[]})
      ]);
      return NextResponse.json({ok:true});
    }
    if (action === "removeMember") {
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      if (!(await hasJamaatScope(j,"roster"))) return fail("You cannot remove Jamaat members.",403);
      const selected = await personInMarkaz(body.personId);
      if (!selected) return fail("Person not found.",404);
      const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,selected.id,markazId).first<Row>();
      if (!member) return fail("This person is not in the Jamaat.",404);
      if (data(j.data).ameerStatus === "approved" && data(j.data).ameerId === selected.id) return fail("Appoint a replacement Ameer before removing this person.",409);
      const stamp = now();
      const changes = [
        db.prepare("DELETE FROM memberships WHERE id = ? AND markaz_id = ? AND NOT EXISTS (SELECT 1 FROM objects WHERE id = ? AND markaz_id = ? AND kind = 'jamaat' AND json_extract(data,'$.ameerStatus') = 'approved' AND json_extract(data,'$.ameerId') = ?)").bind(member.id,markazId,j.id,markazId,selected.id),
        db.prepare("UPDATE objects SET data = json_set(data,'$.personId',NULL,'$.removedAssigneeId',?),status = 'unassigned',updated_at = ? WHERE kind = 'assignment' AND parent_id = ? AND markaz_id = ? AND json_valid(data) AND json_extract(data,'$.personId') = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = ?)").bind(selected.id,stamp,j.id,markazId,selected.id,j.id,selected.id),
        db.prepare("UPDATE objects SET data = json_set(data,'$.personIds',json(COALESCE((SELECT json_group_array(value) FROM json_each(objects.data,'$.personIds') WHERE value <> ?),'[]')),'$.removedPersonIds',json_insert(COALESCE(json_extract(data,'$.removedPersonIds'),json('[]')),'$[#]',?)),updated_at = ? WHERE kind = 'umoor' AND markaz_id = ? AND parent_id IN (SELECT id FROM objects WHERE kind = 'mashwara' AND parent_id = ? AND markaz_id = ? AND json_extract(data,'$.daily') = 1) AND json_valid(data) AND EXISTS (SELECT 1 FROM json_each(data,'$.personIds') WHERE value = ?) AND NOT EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = ?)").bind(selected.id,selected.id,stamp,markazId,j.id,markazId,selected.id,j.id,selected.id),
        db.prepare("UPDATE objects SET data = json_set(data,'$.ameerId',NULL,'$.formerDailyAmeerId',?),updated_at = ? WHERE kind = 'mashwara' AND parent_id = ? AND markaz_id = ? AND json_extract(data,'$.daily') = 1 AND json_extract(data,'$.ameerId') = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = ?)").bind(selected.id,stamp,j.id,markazId,selected.id,j.id,selected.id),
        db.prepare("UPDATE objects SET status = 'removed',updated_at = ? WHERE kind IN ('collaborator','attendee') AND markaz_id = ? AND parent_id IN (SELECT id FROM objects WHERE kind = 'mashwara' AND parent_id = ? AND markaz_id = ? AND json_extract(data,'$.daily') = 1) AND json_extract(data,'$.personId') = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE jamaat_id = ? AND person_id = ?)").bind(stamp,markazId,j.id,markazId,selected.id,j.id,selected.id),
        auditChange("member.remove",String(j.id),String(selected.id),{membershipId:String(member.id)})
      ];
      const result = await db.batch(changes);
      if (!result[0].meta.changes) return fail("Ameer or membership changed. Reload and try again.",409);
      return NextResponse.json({ok:true});
    }
    if (action === "updateProfile") {
      const expected=body.expectedPerson;
      const profileFields=["name","phone","email","localMasjidId","localMarkazId","nationalMarkazId"] as const;
      if(!expected||typeof expected!=="object"||Array.isArray(expected)||Object.keys(expected).sort().join(",")!==[...profileFields].sort().join(","))return fail("Reload your profile before saving.",409);
      const prior=expected as Record<string,unknown>;
      if(typeof prior.name!=="string"||profileFields.slice(1).some(field=>prior[field]!==null&&typeof prior[field]!=="string"))return fail("Reload your profile before saving.",409);
      const placeFields = ["localMasjidId","localMarkazId","nationalMarkazId"] as const;
      const values: (string|null)[] = [];
      for (const field of placeFields) {
        const value = clean(body[field],80);
        if (value) {
          const p = await object(value);
          if (!p || p.kind !== "place" || p.status==="archived") return fail("Choose an active place from this Markaz.");
        }
        values.push(value || null);
      }
      const name = clean(body.name,100) || String(person.name);
      const phone = clean(body.phone,40) || null;
      const email = clean(body.email,150) || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Check the email address.");
      const guardId=id(),afterProfile={name,phone,email,localMasjidId:values[0],localMarkazId:values[1],nationalMarkazId:values[2]};
      const fields=profileFields.filter(field=>prior[field]!==afterProfile[field]);
      try{await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM people WHERE id=? AND markaz_id=? AND merged_into_id IS NULL AND name=? AND phone IS ? AND email IS ? AND local_masjid_id IS ? AND local_markaz_id IS ? AND national_markaz_id IS ?) THEN ? ELSE 'stale' END").bind(person.id,markazId,prior.name,prior.phone,prior.email,prior.localMasjidId,prior.localMarkazId,prior.nationalMarkazId,guardId),
        db.prepare("UPDATE people SET name = ?, phone = ?, email = ?, local_masjid_id = ?, local_markaz_id = ?, national_markaz_id = ? WHERE id = ? AND markaz_id=? AND merged_into_id IS NULL AND name=? AND phone IS ? AND email IS ? AND local_masjid_id IS ? AND local_markaz_id IS ? AND national_markaz_id IS ?").bind(name,phone,email,...values,person.id,markazId,prior.name,prior.phone,prior.email,prior.localMasjidId,prior.localMarkazId,prior.nationalMarkazId),
        auditChange("person.profile.correct",String(person.id),String(person.id),{fields}),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId)
      ]);}catch{return fail("Your profile changed. Reload and review it.",409);}
      return NextResponse.json({ ok:true });
    }
    if (action === "correctBaraka") {
      if (Object.keys(body).some(key=>!["action","originalId","expectedUpdatedAt","idempotencyKey","mode","reason","date","replacement"].includes(key))) return fail("Unsupported Baraka correction field.");
      const original=await object(body.originalId);
      if (!original || original.kind!=="money") return fail("Baraka entry not found.",404);
      const j=await object(original.parent_id);
      if (!j || j.kind!=="jamaat") return fail("Jamaat not found.",404);
      if (!(await hasJamaatScope(j,"funds"))) return fail("You cannot correct this Jamaat's Baraka.",403);
      if (body.expectedUpdatedAt!==original.updated_at) return fail("This Baraka entry changed. Reload and review it.",409);
      const old=data(original.data);
      if (old.reversalOf || !["collection","expense"].includes(String(old.type)) || !validLedgerCents(old.amountCents) || (old.currency&&old.currency!=="CAD")) return fail("This historical amount needs receipt review before correction.",409);
      const mode=body.mode;
      if (mode!=="reverse"&&mode!=="replace") return fail("Choose a reversal or a replacement.");
      if (typeof body.reason!=="string" || body.reason.trim().length<5 || body.reason.length>500) return fail("Explain the correction in 5 to 500 characters.");
      const reason=body.reason.trim();
      if (!isCivilDate(body.date)) return fail("Choose a valid local correction day.");
      if (typeof body.idempotencyKey!=="string" || !/^[A-Za-z0-9:_-]{8,100}$/.test(body.idempotencyKey)) return fail("Use a stable correction request ID.");
      const replacement=body.replacement;
      if (mode==="reverse" && replacement!==undefined) return fail("A reversal has no replacement entry.");
      let replacementFields:Record<string,unknown>|null=null,replacementTitle="";
      if (mode==="replace") {
        if (!plainObject(replacement) || Object.keys(replacement).some(key=>!["title","type","amountCents","note","reference"].includes(key))) return fail("Enter valid replacement details.");
        if (typeof replacement.title!=="string" || !replacement.title.trim() || replacement.title.length>200 || !["collection","expense"].includes(String(replacement.type)) || !validLedgerCents(replacement.amountCents) || typeof replacement.note!=="string" || replacement.note.length>500 || typeof replacement.reference!=="string" || replacement.reference.length>120) return fail("Check the replacement amount, type, description and reference.");
        replacementTitle=replacement.title.trim();
        replacementFields={type:replacement.type,amountCents:replacement.amountCents,currency:"CAD",date:body.date,note:replacement.note.trim(),reference:replacement.reference.trim(),replaces:original.id};
      }
      const key=body.idempotencyKey;
      const payloadJson=JSON.stringify({originalId:original.id,mode,reason,date:body.date,replacement:replacementFields?{title:replacementTitle,fields:replacementFields}:null});
      const prior=await db.prepare("SELECT payload_json,result_id,replacement_id FROM baraka_operations WHERE jamaat_id=? AND idempotency_key=?").bind(j.id,key).first<Row>();
      if (prior) return prior.payload_json===payloadJson?NextResponse.json({ok:true,id:prior.result_id,replacementId:prior.replacement_id,existing:true}):fail("This correction request ID was used for different details.",409);
      const already=await db.prepare("SELECT result_id FROM baraka_operations WHERE original_id=?").bind(original.id).first<Row>();
      if (already) return fail("This entry was already corrected. Review its reversal before changing it again.",409);
      const stamp=now(),reversalId=id(),replacementId=replacementFields?id():null;
      const reversalData={type:old.type==="collection"?"expense":"collection",amountCents:old.amountCents,currency:"CAD",date:body.date,note:"Reversal",reference:old.reference||"",reversalOf:original.id,correctionReason:reason,correctionBy:person.id,correctionAt:stamp};
      const writes=[
        db.prepare("INSERT INTO baraka_operations (markaz_id,jamaat_id,idempotency_key,operation_kind,payload_json,result_id,original_id,replacement_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(markazId,j.id,key,"correction",payloadJson,reversalId,original.id,replacementId,person.id,stamp),
        db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(reversalId,markazId,"money",j.id,`Reversal of ${String(original.title).slice(0,188)}`,"recorded",JSON.stringify(reversalData),person.id,stamp,stamp),
      ];
      if (replacementFields && replacementId) writes.push(db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(replacementId,markazId,"money",j.id,replacementTitle,"recorded",JSON.stringify({...replacementFields,correctionBy:person.id,correctionAt:stamp}),person.id,stamp,stamp));
      writes.push(auditChange("money.correction",String(original.id),null,{fields:replacementFields?["reversal","replacement"]:["reversal"]}));
      try { await db.batch(writes); }
      catch {
        const winner=await db.prepare("SELECT payload_json,result_id,replacement_id FROM baraka_operations WHERE jamaat_id=? AND idempotency_key=?").bind(j.id,key).first<Row>();
        if (winner) return winner.payload_json===payloadJson?NextResponse.json({ok:true,id:winner.result_id,replacementId:winner.replacement_id,existing:true}):fail("This correction request ID was used for different details.",409);
        return fail("This entry was corrected while saving. Reload the ledger.",409);
      }
      return NextResponse.json({ok:true,id:reversalId,replacementId});
    }
    if (action === "reviseRecordedInfo") {
      if (typeof body.id!=="string" || !body.id || body.id.length>80) return fail("Choose a recorded item.");
      const item=await object(body.id);
      if (!item || !["note","tashkil","masjid_note","incident"].includes(String(item.kind))) return fail("Recorded item not found.",404);
      if(item.status==="archived")return fail("Restore this archived record before correcting it.",409);
      const scope: JamaatScope=item.kind==="note"||item.kind==="masjid_note"?"notes":item.kind==="tashkil"?"tashkil":"incidents";
      const jamaatId=item.kind==="masjid_note"?data(item.data).jamaatId:item.parent_id;
      const jamaat=jamaatId?await object(jamaatId):null;
      if (!leader && (!jamaat || jamaat.kind!=="jamaat" || !(await hasJamaatScope(jamaat,scope)))) return fail("You cannot revise this record.",403);
      if (body.expectedUpdatedAt!==item.updated_at) return fail("This record changed. Reload it before saving a correction.",409);
      const input=recordedRevisionInput(body,String(item.kind));
      if (item.kind==="masjid_note" && input.values.jamaatId!==jamaatId) return fail("A handover cannot be moved to another Jamaat. Create a new handover for that route.");
      if (item.kind==="masjid_note" && !(await db.prepare("SELECT 1 FROM objects WHERE markaz_id=? AND kind='stay' AND parent_id=? AND json_valid(data) AND json_extract(data,'$.placeId')=? LIMIT 1").bind(markazId,jamaatId,item.parent_id).first<Row>())) return fail("This handover's venue is no longer on the Jamaat route. Review it before correcting.",409);
      if (item.kind==="note" && !input.values.text) return fail("Enter the Jamaat note.");
      if (item.kind==="masjid_note" && !input.values.text && !input.values.localWork) return fail("Enter local conditions or another handover note.");
      if (item.kind==="tashkil" && !input.values.intention && !input.values.note && !input.values.followUp) return fail("Enter the intention, note or follow-up.");
      if (item.kind==="tashkil" && input.values.followUpOwnerId && !(await db.prepare("SELECT 1 FROM memberships WHERE markaz_id=? AND jamaat_id=? AND person_id=? LIMIT 1").bind(markazId,jamaatId,input.values.followUpOwnerId).first<Row>())) return fail("Choose a current Jamaat member for follow-up.");
      if (item.kind==="incident" && !input.values.description) return fail("Describe what happened.");
      if (item.kind==="incident" && input.status==="resolved" && !input.values.followUp) return fail("Record the resolution follow-up before resolving.");
      const previous={title:item.title,status:item.status,data:data(item.data)};
      const next={title:input.title,status:item.kind==="incident"?input.status:item.status,data:{...data(item.data),...input.values}};
      const stamp=nextStamp(item.updated_at),assertId=id();
      try { await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM objects WHERE id=? AND markaz_id=? AND updated_at=?) THEN ? ELSE 'stale' END").bind(item.id,markazId,item.updated_at,assertId),
        db.prepare("UPDATE objects SET title=?,status=?,data=?,updated_at=? WHERE id=? AND markaz_id=? AND updated_at=?").bind(next.title,next.status,JSON.stringify(next.data),stamp,item.id,markazId,item.updated_at),
        db.prepare("INSERT INTO recorded_revisions (id,markaz_id,object_id,kind,actor_id,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id(),markazId,item.id,item.kind,person.id,input.reason,JSON.stringify(previous),JSON.stringify(next),stamp),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(assertId),auditChange(String(item.kind)+".revise",String(item.id),null,{fields:["title","status",...Object.keys(input.values)],previousStatus:String(item.status),nextStatus:String(next.status)})
      ]); } catch { return fail("This record changed while saving. Reload it and review the correction.",409); }
      return NextResponse.json({ok:true,id:item.id,updatedAt:stamp});
    }
    if (action === "createItem") {
      const input = createItemInput(body);
      const {kind,parentId,title,start,end} = input;
      const parent = parentId ? await object(parentId) : null;
      const supplied = input.values;
      let fields: Record<string, unknown> = {};
      let status = "planned";
      let dutyEvent:Row|null = null;
      let barakaKey="",barakaPayload="";
      if (kind === "place") {
        if (!leader) return fail("Only Markaz leaders can add places.",403);
        if (parentId) return fail("A place cannot have a parent.");
        const existingPlaces=(await db.prepare("SELECT id,title,data FROM objects WHERE markaz_id=? AND kind='place' AND status<>'archived'").bind(markazId).all<Row>()).results;
        const duplicates=existingPlaces.filter(row=>potentialDuplicate({name:title,address:String(supplied.address||"")},{name:String(row.title),address:String(data(row.data).address||"")})).map(row=>({id:row.id,title:row.title}));
        if(duplicates.length&&body.allowPotentialDuplicate!==true)return NextResponse.json({error:"A possible duplicate exists. Review it before creating another place.",duplicates},{status:409});
        fields = { ...supplied, source:"custom", provenance:"user-supplied", hostPermission:"unknown" };
        status="active";
      } else if (["stay","assignment","note","money","tashkil","message","masjid_note"].includes(kind)) {
        if (kind === "masjid_note" && (!parent || parent.kind !== "place" || parent.status==="archived")) return fail("Choose an active place from this Markaz.");
        const j = kind === "masjid_note" ? await object(supplied.jamaatId) : parent;
        if (!j || j.kind !== "jamaat") return fail("Choose a Jamaat.",404);
        const required: JamaatScope = kind === "assignment" ? "amaal" : kind === "note" || kind === "masjid_note" ? "notes" : kind === "money" ? "funds" : kind === "tashkil" ? "tashkil" : "route";
        const manager = await hasJamaatScope(j,required);
        if (!manager && kind !== "message") return fail("You cannot edit this Jamaat.",403);
        if (kind === "message" && !manager) {
          const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ?").bind(j.id,person.id).first<Row>();
          if (!member) return fail("You are not in this Jamaat.",403);
        }
        if (kind === "stay") {
          const placeId = clean(supplied.placeId,80);
          const place = await object(placeId);
          if (!place || place.kind !== "place" || place.status==="archived" || !start || !end) return fail("Choose an active place and stay dates.");
          const stayZone=scheduleZone(data(j.data).timeZone || markazZone);
          if(!stayFitsTrip(start,end,String(j.start_at),String(j.end_at),stayZone)) return fail("Stay dates must fit within the Jamaat trip.");
          if(supplied.hostStatus==="confirmed"){
            const existing=(await db.prepare("SELECT start_at,end_at,status,data FROM objects WHERE markaz_id = ? AND parent_id = ? AND kind = 'stay'").bind(markazId,j.id).all<Row>()).results;
            if(existing.some(row=>row.status!=="cancelled"&&data(row.data).hostStatus==="confirmed"&&row.start_at&&row.end_at&&stayRangesOverlap({startAt:start,endAt:end},{startAt:String(row.start_at),endAt:String(row.end_at)},stayZone))) return fail("Confirmed stays cannot overlap.");
          }
          fields = { placeId, hostStatus:supplied.hostStatus, conditions:supplied.conditions, timeZone:stayZone };
        }
        if (kind === "assignment") {
          const amal = clean(supplied.amal,80);
          if (![...standardAmal,...mastooraatAmal].includes(amal)) return fail("Choose an a'maal.");
          if (mastooraatAmal.includes(amal) && data(j.data).kind !== "mastooraat") return fail("This a'maal is for a Mastooraat Jamaat.");
          const assignmentDay=String(supplied.date||"");
          if(!isCivilDate(assignmentDay)||assignmentDay<String(j.start_at).slice(0,10)||assignmentDay>String(j.end_at).slice(0,10))return fail("Choose an assignment day within this Jamaat's trip.");
          const assignee = clean(supplied.personId,80);
          if (assignee && !(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,assignee,markazId).first<Row>())) return fail("Choose a member of this Jamaat.");
          fields = { amal, personId:assignee||null, date:supplied.date, details:supplied.details };
          if (!fields.date) return fail("Choose a date.");
          const daily = await object(`daily:${String(j.id)}:${String(fields.date)}`);
          if (daily?.kind === "mashwara") return fail("This day has a daily Mashwara. Assign its a‘maal there so the day plan stays together.");
        }
        if (kind === "note") fields = { ...supplied, category:supplied.category||"general" };
        if (kind === "money") {
          if (typeof body.idempotencyKey!=="string" || !/^[A-Za-z0-9:_-]{8,100}$/.test(body.idempotencyKey)) return fail("Use a stable Baraka request ID when saving or retrying.");
          barakaKey=body.idempotencyKey;
          fields={...supplied,currency:"CAD"};
          barakaPayload=JSON.stringify({parentId:j.id,title,fields});
          const prior=await db.prepare("SELECT payload_json,result_id FROM baraka_operations WHERE jamaat_id=? AND idempotency_key=?").bind(j.id,barakaKey).first<Row>();
          if(prior) return prior.payload_json===barakaPayload?NextResponse.json({ok:true,id:prior.result_id,existing:true}):fail("This Baraka request ID was used for different details.",409);
        }
        if (kind === "tashkil") {
          if (!supplied.intention && !supplied.note && !supplied.followUp) return fail("Enter the intention, note or follow-up.");
          if (supplied.followUpOwnerId && !(await db.prepare("SELECT 1 FROM memberships WHERE markaz_id=? AND jamaat_id=? AND person_id=? LIMIT 1").bind(markazId,j.id,supplied.followUpOwnerId).first<Row>())) return fail("Choose a current Jamaat member for follow-up.");
          fields = supplied;
        }
        if (kind === "message") fields = { text:supplied.text, authorId:person.id, requestId:body.requestId||null };
        if (kind === "masjid_note") {
          if (!(await db.prepare("SELECT 1 FROM objects WHERE markaz_id=? AND kind='stay' AND parent_id=? AND json_valid(data) AND json_extract(data,'$.placeId')=? LIMIT 1").bind(markazId,j.id,parentId).first<Row>())) return fail("Choose a venue on this Jamaat's route.");
          fields = { jamaatId:j.id, text:supplied.text, localWork:supplied.localWork };
        }
        if (["note","message"].includes(kind) && !clean(fields.text,4000)) return fail("Enter a note or message.");
        if (kind === "masjid_note" && !clean(fields.text,4000) && !clean(fields.localWork,4000)) return fail("Enter local conditions or a note.");
      } else if (kind === "incident") {
        if (parentId && parent?.kind !== "jamaat") return fail("Choose a Jamaat.");
        if (!leader && (!parent || parent.kind !== "jamaat" || !(await hasJamaatScope(parent,"incidents")))) return fail("You cannot report an incident here.",403);
        fields = { ...supplied, reportedBy:person.id };
        status = "open";
        if (!fields.description) return fail("Describe what happened.");
      } else if (kind === "event") {
        if (!leader) return fail("Only Markaz leaders can create events.",403);
        if (parentId) return fail("An event cannot have a parent.");
        const locationId = String(supplied.locationId || "");
        if (locationId) {
          const place = await object(locationId);
          if (!place || place.kind !== "place" || place.status==="archived") return fail("Choose an active place from this Markaz.");
        }
        fields = { ...supplied, locationId:locationId||null, timeZone:markazZone };
      } else if (kind === "team" || kind === "duty") {
        const event = kind === "team" ? parent : parent?.kind === "team" ? await object(parent.parent_id) : null;
        if (!event || event.kind !== "event") return fail("Choose a team in this Markaz.",404);
        if (kind === "team" && !leader) return fail("Only Markaz leaders can add event teams.",403);
        if (kind === "duty" && !leader && data(parent?.data).personId !== person.id) return fail("Only this team's Ameer can assign duties.",403);
        if (event.status === "completed" || event.status === "cancelled") return fail("This event is closed to duty changes.",409);
        const selected = clean(supplied.personId,80);
        if (selected && !(await personInMarkaz(selected))) return fail("Choose a person from this Markaz.");
        const dueAt = supplied.dueAt ? parseOffsetInstant(supplied.dueAt) : null;
        if (kind === "duty" && supplied.dueAt && !dueAt) return fail("Choose a valid duty due date and time.");
        if (kind === "duty" && dueAt) {
          const dueDay = localDay(dueAt,scheduleZone(data(event.data).timeZone||markazZone));
          const zone=scheduleZone(data(event.data).timeZone||markazZone);
          if (!dueDay || dueDay < localDay(String(event.start_at),zone)! || dueDay > localDay(String(event.end_at),zone)!) return fail("Duty due time must fall on an event day.");
        }
        fields = kind === "duty" ? { personId:selected||null,details:supplied.details,dueAt } : { personId:selected||null,details:supplied.details };
        if (kind === "duty") { status="open"; dutyEvent=event; }
      } else {
        return fail("Unknown item type.");
      }
      const oid = (kind === "duty" || kind === "message") && body.requestId ? `${kind}:${String(body.requestId)}` : id(), stamp = now();
      const sameDutyRequest=(existing:Row|null)=>existing?.kind==="duty"&&existing.parent_id===parentId&&existing.created_by===person.id&&existing.title===title&&data(existing.data).personId===fields.personId&&data(existing.data).details===fields.details&&data(existing.data).dueAt===fields.dueAt;
      const sameMessageRequest=(existing:Row|null)=>existing?.kind==="message"&&existing.parent_id===parentId&&existing.created_by===person.id&&existing.title===title&&data(existing.data).text===fields.text;
      if (kind === "duty" && body.requestId) {
        const existing=await object(oid);
        if (existing) return sameDutyRequest(existing) ? NextResponse.json({ok:true,id:oid,existing:true}) : fail("This duty request ID was already used.",409);
      }
      if (kind === "message" && body.requestId) {
        const existing=await object(oid);
        if(existing)return sameMessageRequest(existing)?NextResponse.json({ok:true,id:oid,existing:true}):fail("This message request ID was used for different text.",409);
      }
      const records=[db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,start_at,end_at,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(oid,markazId,kind,parentId,title,start,end,status,JSON.stringify(fields),person.id,stamp,stamp)];
      if (kind === "money") records.unshift(db.prepare("INSERT INTO baraka_operations (markaz_id,jamaat_id,idempotency_key,operation_kind,payload_json,result_id,original_id,replacement_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(markazId,parentId,barakaKey,"create",barakaPayload,oid,null,null,person.id,stamp));
      if (kind === "duty" && dutyEvent) {
        const guardId=id();
        records.unshift(db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM objects t JOIN objects e ON e.id=t.parent_id AND e.markaz_id=t.markaz_id WHERE t.id=? AND t.kind='team' AND t.markaz_id=? AND e.id=? AND e.kind='event' AND e.status IN ('planned','active') AND (?=1 OR json_extract(t.data,'$.personId')=?)) THEN ? ELSE 'stale' END").bind(parentId,markazId,dutyEvent.id,leader?1:0,person.id,guardId));
        records.push(db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId));
      } else if (kind === "team") {
        const guardId=id();
        records.unshift(db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM objects WHERE id=? AND markaz_id=? AND kind='event' AND status IN ('planned','active')) THEN ? ELSE 'stale' END").bind(parentId,markazId,guardId));
        records.push(db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId));
      }
      if(kind==="stay"&&parent&&start&&end){
        const existingStays=(await db.prepare("SELECT start_at,end_at,status,data FROM objects WHERE markaz_id = ? AND parent_id = ? AND kind = 'stay'").bind(markazId,parent.id).all<Row>()).results;
        const allStays=[...existingStays.filter(row=>row.start_at&&row.end_at).map(row=>({startAt:String(row.start_at),endAt:String(row.end_at),status:String(row.status),placeId:String(data(row.data).placeId||"")})),{startAt:start,endAt:end,status,placeId:String(fields.placeId||"")}];
        const dailyRows=(await db.prepare("SELECT id,data FROM objects WHERE markaz_id = ? AND parent_id = ? AND kind = 'mashwara' AND json_valid(data) AND json_extract(data,'$.daily') = 1").bind(markazId,parent.id).all<Row>()).results;
        const stayZone=scheduleZone(data(parent.data).timeZone||markazZone);
        for(const dailyRow of dailyRows){const details=data(dailyRow.data),day=String(details.date||"");if(!isCalendarDate(day))continue;const locationId=venueForDay(day,allStays,stayZone);if(details.locationId!==locationId)records.push(db.prepare("UPDATE objects SET data = json_set(data,'$.locationId',?),updated_at = ? WHERE id = ? AND markaz_id = ?").bind(locationId,stamp,dailyRow.id,markazId));}
      }
      records.push(auditChange(kind+".create",oid));
      try { await db.batch(records); }
      catch(error) {
        if (kind === "money") {
          const prior=await db.prepare("SELECT payload_json,result_id FROM baraka_operations WHERE jamaat_id=? AND idempotency_key=?").bind(parentId,barakaKey).first<Row>();
          if (prior) return prior.payload_json===barakaPayload?NextResponse.json({ok:true,id:prior.result_id,existing:true}):fail("This Baraka request ID was used for different details.",409);
          throw error;
        }
        if (kind === "team") return fail("The event changed while saving. Reload and try again.",409);
        if (kind === "message" && body.requestId) {
          const existing=await object(oid);
          if(sameMessageRequest(existing))return NextResponse.json({ok:true,id:oid,existing:true});
          if(!existing)throw error;
          return fail("This message request ID was used for different text.",409);
        }
        if (kind !== "duty") throw error;
        const existing=await object(oid);
        if (sameDutyRequest(existing)) return NextResponse.json({ok:true,id:oid,existing:true});
        return fail("The team or event changed while saving. Reload and try again.",409);
      }
      return NextResponse.json({ ok:true, id:oid });
    }
    if (action === "createDailyMashwara") {
      const j = await object(body.jamaatId);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      if (!(await hasJamaatScope(j,"amaal"))) return fail("Only this Jamaat’s a‘maal planners can add a daily Mashwara.",403);
      const date = clean(body.date,10);
      if (!isCalendarDate(date)) return fail("Choose a valid Mashwara date.");
      if (date < String(j.start_at).slice(0,10) || date > String(j.end_at).slice(0,10)) return fail("Choose a day within this Jamaat’s dates.");
      const ameerId = clean(body.ameerId,80);
      const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,ameerId,markazId).first<Row>();
      if (!member) return fail("Choose one member of this Jamaat as Mashwara Ameer.");
      const mid = `daily:${String(j.id)}:${date}`;
      const existing = await db.prepare("SELECT id FROM objects WHERE markaz_id = ? AND parent_id = ? AND kind = 'mashwara' AND json_valid(data) AND json_extract(data,'$.daily') = 1 AND json_extract(data,'$.date') = ? LIMIT 1").bind(markazId,j.id,date).first<Row>();
      if (existing) return NextResponse.json({ ok:true, id:existing.id, existing:true });
      const stamp = now();
      const stayRows = (await db.prepare("SELECT start_at,end_at,status,data FROM objects WHERE markaz_id = ? AND kind = 'stay' AND parent_id = ?").bind(markazId,j.id).all<Row>()).results;
      const stayZone=scheduleZone(data(j.data).timeZone||markazZone);
      const locationId=venueForDay(date,stayRows.filter(row=>row.start_at&&row.end_at).map(row=>({startAt:String(row.start_at),endAt:String(row.end_at),placeId:String(data(row.data).placeId||""),status:String(row.status)})),stayZone);
      const assignments = (await db.prepare("SELECT data FROM objects WHERE markaz_id = ? AND kind = 'assignment' AND parent_id = ? AND status <> 'historical' AND json_valid(data) AND json_extract(data,'$.date') = ?").bind(markazId,j.id,date).all<Row>()).results;
      const currentMembers = (await db.prepare("SELECT person_id FROM memberships WHERE jamaat_id = ? AND markaz_id = ?").bind(j.id,markazId).all<Row>()).results;
      const memberIds = new Set(currentMembers.map(member=>String(member.person_id)));
      const previousAssignments = assignments.map(a=>data(a.data));
      const validAssignments = previousAssignments.filter(a=>a.needsAssignmentReview!==true&&(a.personId==null || (typeof a.personId==="string"&&memberIds.has(a.personId))));
      const skippedLegacyAssignmentCount = previousAssignments.length-validAssignments.length;
      const fields = { type:"jamaat", daily:true, date, jamaatId:j.id, recurrence:"none", ameerId, visibility:"jamaat", locationId, details:clean(body.details,2000), skippedLegacyAssignmentCount };
      const records = [db.prepare("INSERT OR IGNORE INTO objects (id,markaz_id,kind,parent_id,title,start_at,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(mid,markazId,"mashwara",j.id,`${String(j.title)} · Daily Mashwara`,date,"planned",JSON.stringify(fields),person.id,stamp,stamp)];
      amalForJamaat(data(j.data).kind).forEach((amal,index) => {
        const previous = validAssignments.filter(a=>a.amal===amal);
        const personIds = [...new Set(previous.map(a=>a.personId).filter((p):p is string=>typeof p==="string"))];
        const ud = { amal, builtin:true, active:previous.length>0, personIds, notes:previous.map(a=>clean(a.details,500)).filter(Boolean).join("\n"), decision:"", followUp:"", order:index };
        records.push(db.prepare("INSERT OR IGNORE INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(`${mid}:amal:${index}`,markazId,"umoor",mid,amal,"open",JSON.stringify(ud),person.id,stamp,stamp));
      });
      await db.batch([...records,auditChange("daily-mashwara.create",mid)]);
      return NextResponse.json({ ok:true, id:mid, existing:false });
    }
    if (action === "setDailyAmal") {
      const u = await object(body.umoorId);
      if (!u || u.kind !== "umoor" || data(u.data).builtin !== true) return fail("Daily a‘maal not found.",404);
      const m = await object(u.parent_id);
      if (!m || m.kind !== "mashwara" || data(m.data).daily !== true || !(await canPlanMashwara(m))) return fail("Only this Mashwara’s planners can assign its a‘maal.",403);
      const j = await object(m.parent_id);
      if (!j || j.kind !== "jamaat") return fail("Jamaat not found.",404);
      const ud = data(u.data), md = data(m.data), amal = clean(ud.amal,80);
      if (!amalForJamaat(data(j.data).kind).includes(amal)) return fail("This a‘maal is not available for this Jamaat.");
      if (!Array.isArray(body.personIds) || body.personIds.length > 100) return fail("Choose up to 100 Jamaat members.");
      const selectedIds = [...new Set(body.personIds.map(p=>clean(p,80)).filter(Boolean))];
      const jamaatMembers = (await db.prepare("SELECT person_id FROM memberships WHERE jamaat_id = ? AND markaz_id = ?").bind(j.id,markazId).all<Row>()).results;
      if (selectedIds.some(pid=>!jamaatMembers.some(member=>member.person_id===pid))) return fail("Assignments must be for members of this Jamaat.");
      const active = body.active === true, personIds = active ? selectedIds : [], notes = clean(body.notes,2000), stamp = now();
      const fields = {...ud, active, personIds, notes};
      const changes = [
        db.prepare("UPDATE objects SET data = ?, updated_at = ? WHERE id = ? AND markaz_id = ?").bind(JSON.stringify(fields),stamp,u.id,markazId),
        db.prepare("DELETE FROM objects WHERE kind = 'assignment' AND parent_id = ? AND markaz_id = ? AND json_extract(data,'$.date') = ? AND json_extract(data,'$.amal') = ?").bind(j.id,markazId,md.date,amal),
      ];
      if (active) {
        (personIds.length?personIds:[null]).forEach((pid,index) => {
          const fields = { amal, personId:pid, date:md.date, details:notes, mashwaraId:m.id, umoorId:u.id };
          changes.push(db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(`${String(u.id)}:a:${index}`,markazId,"assignment",j.id,amal,"planned",JSON.stringify(fields),person.id,stamp,stamp));
        });
      }
      await db.batch([...changes,auditChange("daily-amal.plan",String(u.id))]);
      return NextResponse.json({ ok:true });
    }
    if (action === "createMashwara") {
      if (!leader && !(await leadsApprovedJamaat())) return fail("Only Markaz leaders and approved Ameers can plan mashwaras.",403);
      const input = createMashwaraInput(body);
      const {title,start,recurrence} = input;
      const mashwaraType = input.type;
      const ameerId = input.ameerId || String(person.id);
      if (!(await personInMarkaz(ameerId))) return fail("Choose a Mashwara Ameer from this Markaz.");
      const locationId = input.locationId;
      if (locationId) {
        const place = await object(locationId);
        if (!place || place.kind !== "place" || place.status==="archived") return fail("Choose an active place from this Markaz.");
      }
      const visibility = input.visibility;
      const seriesId = id(), stamp = now(),timeZone=input.timeZone||markazZone;
      const fields = { type:mashwaraType, recurrence, seriesId, occurrence:1, ameerId, locationId:locationId||null, visibility, details:input.details, timeZone,monthAnchorDay:recurrence==="monthly"?Number(localDateTimeInput(start,timeZone).slice(8,10)):null };
      if(recurrence!=="none"){
        const rule:RecurrenceRule={anchorInstant:start,timeZone,frequency:recurrence as RecurrenceRule["frequency"],endCount:input.seriesEndCount,endDay:input.seriesEndDay};
        if(!seriesOccurrence(rule,0))return fail("The series ends before its first Mashwara.");
      }
      const records=[db.prepare("INSERT INTO objects (id,markaz_id,kind,title,start_at,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(seriesId,markazId,"mashwara",title,start,"planned",JSON.stringify(fields),person.id,stamp,stamp)];
      if(recurrence!=="none"){
        const version=id();
        records.push(db.prepare("INSERT INTO mashwara_series (id,markaz_id,anchor_instant,time_zone,frequency,end_count,end_day,next_index,title,template_data,created_by,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(seriesId,markazId,start,timeZone,recurrence,input.seriesEndCount,input.seriesEndDay,1,title,JSON.stringify(fields),person.id,stamp,version));
        records.push(db.prepare("INSERT INTO mashwara_series_changes (id,series_id,start_index,anchor_instant,time_zone,frequency,title,template_data,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id(),seriesId,0,start,timeZone,recurrence,title,JSON.stringify(fields),stamp));
        records.push(db.prepare("INSERT INTO mashwara_occurrences (series_id,position,object_id,original_start_at,exception) VALUES (?,?,?,?,0)").bind(seriesId,0,seriesId,start));
      }
      try { await db.batch([guardedGlobalAudit("mashwara.create",seriesId),...records]); }
      catch { return fail("Your Mashwara-planning authority changed. Reload and try again.",409); }
      if(recurrence!=="none")await materializeMashwaraSeries(db,markazId);
      const generated=recurrence==="none"?1:Number((await db.prepare("SELECT next_index FROM mashwara_series WHERE id = ?").bind(seriesId).first<Row>())?.next_index||1);
      return NextResponse.json({ ok:true, id:seriesId, occurrences:generated, seriesId:recurrence==="none"?null:seriesId });
    }
    if (action === "addCollaborator" || action === "joinMashwara" || action === "leaveMashwara" || action === "suggestUmoor" || action === "addUmoor") {
      const m = await object(body.mashwaraId);
      if (!m || m.kind !== "mashwara") return fail("Mashwara not found.",404);
      const md = data(m.data);
      const planner = await canPlanMashwara(m);
      if (md.daily === true) {
        const j = await object(m.parent_id);
        const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(m.parent_id,person.id,markazId).first<Row>();
        if (!j || (!leader && !member)) return fail("This daily Mashwara is visible only to its Jamaat.",403);
      }
      if ((action === "addCollaborator" || action === "addUmoor") && !planner) return fail("Only Mashwara planners can change this plan.",403);
      if ((action === "joinMashwara" || action === "leaveMashwara" || action === "suggestUmoor") && md.visibility === "private" && !planner) return fail("This Mashwara is private.",403);
      if(action==="joinMashwara"||action==="leaveMashwara"){
        const attendeeId=`attendee:${String(m.id)}:${String(person.id)}`;
        const matches=(await db.prepare("SELECT id,status FROM objects WHERE markaz_id=? AND parent_id=? AND kind='attendee' AND json_valid(data) AND json_extract(data,'$.personId')=? ORDER BY created_at,id").bind(markazId,m.id,person.id).all<Row>()).results;
        const primary=matches[0],active=matches.find(row=>row.status!=="removed");
        if(action==="leaveMashwara"){
          if(!active)return NextResponse.json({ok:true,joined:false,existing:true});
          await db.batch([db.prepare("UPDATE objects SET status='removed',updated_at=? WHERE markaz_id=? AND parent_id=? AND kind='attendee' AND json_valid(data) AND json_extract(data,'$.personId')=? AND status<>'removed'").bind(now(),markazId,m.id,person.id),auditChange("mashwara.leave",String(m.id))]);
          return NextResponse.json({ok:true,joined:false});
        }
        if(active){
          if(matches.filter(row=>row.status!=="removed").length>1)await db.prepare("UPDATE objects SET status='removed',updated_at=? WHERE markaz_id=? AND parent_id=? AND kind='attendee' AND id<>? AND json_valid(data) AND json_extract(data,'$.personId')=? AND status<>'removed'").bind(now(),markazId,m.id,active.id,person.id).run();
          return NextResponse.json({ok:true,joined:true,existing:true});
        }
        if(primary){await db.batch([db.prepare("UPDATE objects SET status='open',updated_at=? WHERE id=? AND markaz_id=?").bind(now(),primary.id,markazId),auditChange("mashwara.rejoin",String(m.id))]);return NextResponse.json({ok:true,joined:true});}
        const stamp=now();
        await db.batch([db.prepare("INSERT OR IGNORE INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(attendeeId,markazId,"attendee",m.id,"Attendee","open",JSON.stringify({personId:person.id}),person.id,stamp,stamp),auditChange("mashwara.join",String(m.id))]);
        return NextResponse.json({ok:true,joined:true});
      }
      const title = clean(body.title,250);
      let kind = "", fields: Record<string,unknown> = {}, parentId = String(m.id);
      if (action === "addCollaborator") {
        const selected = await personInMarkaz(body.personId);
        if (!selected) return fail("Choose a person from this Markaz.");
        if (md.daily === true) {
          const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(m.parent_id,selected.id,markazId).first<Row>();
          if (!member) return fail("Daily Mashwara planners must belong to this Jamaat.");
        }
        if(body.scope==="series"&&md.daily!==true){
          const seriesId=clean(md.seriesId,80);
          const series=seriesId?await db.prepare("SELECT id FROM mashwara_series WHERE id=? AND markaz_id=?").bind(seriesId,markazId).first<Row>():null;
          if(!series)return fail("This Mashwara has no recurring series.");
          await db.batch([db.prepare("INSERT OR IGNORE INTO mashwara_series_collaborators (series_id,person_id,created_at) VALUES (?,?,?)").bind(seriesId,selected.id,now()),auditChange("mashwara.series.planner",seriesId)]);
          return NextResponse.json({ok:true,scope:"series"});
        }
        if(body.scope!==undefined&&body.scope!=="occurrence")return fail("Choose this Mashwara or its series.");
        kind = "collaborator"; fields = { personId:selected.id }; 
      }
      if (action === "suggestUmoor") { if (!title) return fail("Enter a suggestion."); kind = "suggestion"; fields = { personId:person.id, note:clean(body.note,1000) }; }
      if (action === "addUmoor") {
        if (!title) return fail("Enter an umoor.");
        kind = "umoor";
        fields = { notes:clean(body.notes,2000), decision:"", followUp:"", recurring:md.daily!==true&&body.recurring===true, seriesId:md.seriesId||m.id };
      }
      if(kind==="umoor"&&fields.recurring===true){
        const seriesId=clean(md.seriesId,80),series=seriesId?await db.prepare("SELECT * FROM mashwara_series WHERE id=? AND markaz_id=?").bind(seriesId,markazId).first<Row>():null;
        const occurrence=series?await db.prepare("SELECT position FROM mashwara_occurrences WHERE series_id=? AND object_id=?").bind(seriesId,m.id).first<Row>():null;
        if(!series||!occurrence)return fail("Recurring agenda needs a valid series. Reload and review this Mashwara.",409);
        const position=Number(occurrence.position),templateId=id(),stamp=now(),newVersion=id(),guardId=id();
        const targets=(await db.prepare("SELECT object_id FROM mashwara_occurrences WHERE series_id=? AND position>=? ORDER BY position").bind(seriesId,position).all<Row>()).results;
        const shared={...fields,templateId};
        const inserts=targets.map(target=>db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id(),markazId,"umoor",target.object_id,title,"open",JSON.stringify(shared),person.id,stamp,stamp));
        const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT version FROM mashwara_series WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(seriesId,markazId,series.version,guardId);
        try{await db.batch([guard,db.prepare("INSERT INTO mashwara_umoor_templates (id,series_id,start_index,end_index,title,notes,created_by,version) VALUES (?,?,?,?,?,?,?,?)").bind(templateId,seriesId,position,null,title,fields.notes,person.id,id()),...inserts,db.prepare("UPDATE mashwara_series SET version=?,updated_at=? WHERE id=?").bind(newVersion,stamp,seriesId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("umoor.series.create",seriesId)]);}catch{return fail("The series changed. Reload and try again.",409);}
        return NextResponse.json({ok:true,count:targets.length,templateId});
      }
      const targets=[parentId];
      const inserts = targets.map(target => db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id(),markazId,kind,target,title||kind,"open",JSON.stringify(fields),person.id,now(),now()));
      await db.batch([...inserts,auditChange(kind+".create",parentId)]);
      return NextResponse.json({ ok:true, count:targets.length });
    }
    if(action==="reviewSuggestion"){
      const suggestion=await object(body.suggestionId);
      if(!suggestion||suggestion.kind!=="suggestion")return fail("Suggestion not found.",404);
      const meeting=await object(suggestion.parent_id);
      if(!meeting||meeting.kind!=="mashwara"||!(await canPlanMashwara(meeting)))return fail("Only Mashwara planners can review suggestions.",403);
      const decision=body.decision;
      if(decision!=="accept"&&decision!=="reject")return fail("Choose accept or reject.");
      if(body.expectedUpdatedAt!==suggestion.updated_at)return fail("This suggestion changed. Reload and review it.",409);
      if(suggestion.status==="accepted"||suggestion.status==="rejected")return fail("This suggestion was already reviewed. Reload it.",409);
      const rationale=clean(body.rationale,1000),stamp=now()===suggestion.updated_at?new Date(Date.parse(now())+1).toISOString():now(),guardId=id(),umoorId=id();
      const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=? AND status NOT IN ('accepted','rejected'))=? THEN ? ELSE 'stale' END").bind(suggestion.id,markazId,suggestion.updated_at,guardId);
      const writes=[guard,db.prepare("UPDATE objects SET status=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(decision==="accept"?"accepted":"rejected",JSON.stringify({...data(suggestion.data),reviewRationale:rationale,reviewedBy:person.id,reviewedAt:stamp}),stamp,suggestion.id,markazId)];
      if(decision==="accept")writes.push(db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(umoorId,markazId,"umoor",meeting.id,suggestion.title,"open",JSON.stringify({notes:data(suggestion.data).note||"",decision:"",followUp:"",suggestionId:suggestion.id}),person.id,stamp,stamp));
      try{await db.batch([...writes,db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("mashwara.suggestion."+decision,String(suggestion.id))]);}catch{return fail("This suggestion changed during review. Reload it.",409);}
      return NextResponse.json({ok:true,decision,umoorId:decision==="accept"?umoorId:null});
    }
    if (action === "recordOpinion" || action === "setUmoorOutcome") {
      const u = await object(body.umoorId);
      if (!u || u.kind !== "umoor") return fail("Umoor not found.",404);
      const m = await object(u.parent_id);
      if (!m || m.kind !== "mashwara" || !(await canPlanMashwara(m))) return fail("Only Mashwara planners can record proceedings.",403);
      if (action === "recordOpinion") {
        const note = clean(body.note,3000);
        if (!note) return fail("Enter the opinion.");
        const selected = clean(body.personId,80);
        if (selected && !(await personInMarkaz(selected))) return fail("Choose a person from this Markaz.");
        if (selected && data(m.data).daily === true) {
          const member = await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(m.parent_id,selected,markazId).first<Row>();
          if (!member) return fail("Choose a member of this Jamaat, or leave the opinion unnamed.");
        }
        const oid = id();
        await db.batch([
          db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(oid,markazId,"opinion",u.id,"Opinion","recorded",JSON.stringify({ personId:selected||null, note }),person.id,now(),now()),
          auditChange("opinion.create",oid)
        ]);
      } else {
        const ud = data(u.data);
        ud.decision = clean(body.decision,3000);
        ud.followUp = clean(body.followUp,3000);
        const expected=body.expectedUpdatedAt===undefined?u.updated_at:body.expectedUpdatedAt;
        if(expected!==u.updated_at)return fail("This decision changed. Reload and review it.",409);
        const stamp=now()===u.updated_at?new Date(Date.parse(now())+1).toISOString():now(),guardId=id();
        if(ud.decision){ud.decisionBy=person.id;ud.decisionAt=stamp;}
        const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(u.id,markazId,expected,guardId);
        try{await db.batch([guard,db.prepare("UPDATE objects SET data=?,status=?,updated_at=? WHERE id=? AND markaz_id=?").bind(JSON.stringify(ud),body.done===true?"done":"open",stamp,u.id,markazId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("umoor.outcome",String(u.id))]);}
        catch{return fail("This decision changed during saving. Reload and review it.",409);}
      }
      return NextResponse.json({ ok:true });
    }
    if(action==="createFollowUp"||action==="completeFollowUp"){
      const followup=action==="completeFollowUp"?await object(body.followUpId):null;
      const umoor=action==="completeFollowUp"?followup?.kind==="followup"?await object(followup.parent_id):null:await object(body.umoorId);
      if(!umoor||umoor.kind!=="umoor")return fail("Agenda item not found.",404);
      const meeting=await object(umoor.parent_id);
      if(!meeting||meeting.kind!=="mashwara")return fail("Mashwara not found.",404);
      const planner=await canPlanMashwara(meeting);
      if(action==="createFollowUp"){
        if(!planner)return fail("Only Mashwara planners can create follow-ups.",403);
        const title=clean(body.title,250),notes=clean(body.notes,2000),ownerId=clean(body.ownerId,80),dueDay=body.dueDay===""||body.dueDay===null||body.dueDay===undefined?null:body.dueDay;
        if(!title||dueDay!==null&&!isCivilDate(dueDay))return fail("Choose a follow-up title and valid due day.");
        if(ownerId&&!(await personInMarkaz(ownerId)))return fail("Choose a person from this Markaz.");
        if(ownerId&&data(meeting.data).daily===true&&!(await db.prepare("SELECT 1 FROM memberships WHERE jamaat_id=? AND person_id=? AND markaz_id=?").bind(meeting.parent_id,ownerId,markazId).first<Row>()))return fail("Choose a member of this Jamaat.");
        const followupId=id(),stamp=now();
        await db.batch([db.prepare("INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(followupId,markazId,"followup",umoor.id,title,"open",JSON.stringify({notes,ownerId:ownerId||null,dueDay,completedAt:null,completedBy:null}),person.id,stamp,stamp),auditChange("mashwara.followup.create",followupId)]);
        return NextResponse.json({ok:true,id:followupId});
      }
      if(!followup)return fail("Follow-up not found.",404);
      if(!planner&&data(followup.data).ownerId!==person.id)return fail("Only this follow-up's owner or a Mashwara planner can complete it.",403);
      if(body.expectedUpdatedAt!==followup.updated_at)return fail("This follow-up changed. Reload and review it.",409);
      const done=body.done===true;
      if(typeof body.done!=="boolean")return fail("Choose the follow-up state.");
      const stamp=now()===followup.updated_at?new Date(Date.parse(now())+1).toISOString():now(),guardId=id();
      const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(followup.id,markazId,followup.updated_at,guardId);
      try{await db.batch([guard,db.prepare("UPDATE objects SET status=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(done?"done":"open",JSON.stringify({...data(followup.data),completedAt:done?stamp:null,completedBy:done?person.id:null}),stamp,followup.id,markazId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("mashwara.followup."+(done?"complete":"reopen"),String(followup.id))]);}
      catch{return fail("This follow-up changed during saving. Reload and review it.",409);}
      return NextResponse.json({ok:true,done});
    }
    if (action === "saveRoute") {
      const allowed=["action","id","expectedUpdatedAt","jamaatUpdatedAt","linkedVersions","title","startAt","endAt","stayMode","planMode","reconfirm","retainHistory","preserveDuration","placeId","hostStatus","conditions","route","status"];
      if(Object.keys(body).some(key=>!allowed.includes(key))) return fail("Unexpected route field.");
      const targetId=clean(body.id,80),expectedUpdatedAt=clean(body.expectedUpdatedAt,80),jamaatUpdatedAt=clean(body.jamaatUpdatedAt,80);
      if(!targetId||!expectedUpdatedAt||!jamaatUpdatedAt) return fail("Reload this route before editing it.",409);
      const target=await object(targetId);
      if(!target||!["jamaat","stay"].includes(String(target.kind))) return fail("Route item not found.",404);
      const jamaat=target.kind==="jamaat"?target:await object(target.parent_id);
      if(!jamaat||jamaat.kind!=="jamaat") return fail("Jamaat not found.",404);
      if(!(await hasJamaatScope(jamaat,"route"))) return fail("You cannot edit this route.",403);
      const linked=(await db.prepare("SELECT * FROM objects WHERE markaz_id = ? AND parent_id = ? AND kind IN ('stay','mashwara','assignment') ORDER BY id").bind(markazId,jamaat.id).all<Row>()).results.filter(row=>row.kind!=="mashwara"||data(row.data).daily===true);
      const versions=body.linkedVersions;
      if(!Array.isArray(versions)||versions.length>1000||versions.some(version=>!plainObject(version)||typeof version.id!=="string"||typeof version.updatedAt!=="string"||version.id.length>80||version.updatedAt.length>80)) return fail("Reload the linked route records before saving.",409);
      const expected=new Map(versions.map(version=>[version.id,version.updatedAt]));
      if(expected.size!==linked.length||linked.some(row=>expected.get(row.id)!==row.updated_at)||target.updated_at!==expectedUpdatedAt||jamaat.updated_at!==jamaatUpdatedAt) return fail("This route changed in another browser. Reload and review it.",409);
      const asRoute=(row:Row):RouteRow=>({id:String(row.id),kind:String(row.kind),parentId:row.parent_id?String(row.parent_id):null,title:String(row.title),startAt:row.start_at?String(row.start_at):null,endAt:row.end_at?String(row.end_at):null,status:String(row.status),data:data(row.data),updatedAt:String(row.updated_at)});
      const rawStart=body.startAt,rawEnd=body.endAt;
      if(typeof rawStart!=="string"||typeof rawEnd!=="string"||temporalKind(rawStart)==="invalid"||temporalKind(rawEnd)==="invalid") return fail("Choose valid arrival and departure dates.");
      const startAt=temporalKind(rawStart)==="instant"?parseOffsetInstant(rawStart)!:rawStart;
      const endAt=temporalKind(rawEnd)==="instant"?parseOffsetInstant(rawEnd)!:rawEnd;
      const choice:RouteChoice={startAt,endAt};
      if(typeof body.title!=="string"||!body.title.trim()||body.title.length>200)return fail("Enter a route or stay name.");
      choice.title=body.title.trim();
      if(body.stayMode!==undefined){if(body.stayMode!=="shift"&&body.stayMode!=="keep")return fail("Choose what happens to stays.");choice.stayMode=body.stayMode;}
      if(body.planMode!==undefined){if(body.planMode!=="shift"&&body.planMode!=="keep")return fail("Choose what happens to daily plans.");choice.planMode=body.planMode;}
      if(body.reconfirm!==undefined){if(typeof body.reconfirm!=="boolean")return fail("Choose whether hosts need reconfirmation.");choice.reconfirm=body.reconfirm;}
      if(body.retainHistory!==undefined){if(typeof body.retainHistory!=="boolean")return fail("Choose how to handle historical dates.");choice.retainHistory=body.retainHistory;}
      if(body.preserveDuration!==undefined){if(typeof body.preserveDuration!=="boolean")return fail("Choose whether to keep stay duration.");choice.preserveDuration=body.preserveDuration;}
      if(target.kind==="stay"){
        if(body.status!==undefined){if(typeof body.status!=="string"||!["planned","cancelled"].includes(body.status))return fail("Choose a stay state.");choice.status=body.status;}
        const placeId=clean(body.placeId,80);
        const place=placeId?await object(placeId):null;
        if(!place||place.kind!=="place"||place.status==="archived")return fail("Choose an active place from this Markaz.");
        const hostStatus=clean(body.hostStatus,20);
        if(!["proposed","contacted","confirmed","arrived","completed"].includes(hostStatus))return fail("Choose a host arrangement.");
        if(typeof body.conditions!=="string"||body.conditions.length>2000)return fail("Local conditions are too long.");
        choice.placeId=placeId;choice.hostStatus=hostStatus;choice.conditions=body.conditions;
      } else if(body.route!==undefined){
        if(typeof body.route!=="string"||body.route.length>500)return fail("Route summary is too long.");
        choice.route=body.route;
      }
      let changes;
      try{changes=planRouteChange(asRoute(target),asRoute(jamaat),linked.map(asRoute),choice,markazZone);}
      catch(cause){return fail(cause instanceof Error?cause.message:"Could not plan this route.");}
      if(!changes.length)return NextResponse.json({ok:true,unchanged:true});
      const guardId=id(),versionJson=JSON.stringify(versions);
      let stamp=now();
      while(stamp===jamaat.updated_at||linked.some(row=>row.updated_at===stamp))stamp=new Date(Date.parse(stamp)+1).toISOString();
      const guard=db.prepare(`INSERT INTO route_assert (id) SELECT CASE WHEN
        (SELECT updated_at FROM objects WHERE id = ? AND markaz_id = ?) = ?
        AND (SELECT updated_at FROM objects WHERE id = ? AND markaz_id = ?) = ?
        AND (SELECT COUNT(*) FROM objects WHERE markaz_id = ? AND parent_id = ? AND (kind IN ('stay','assignment') OR (kind = 'mashwara' AND CASE WHEN json_valid(data) THEN json_extract(data,'$.daily') ELSE 0 END = 1))) = json_array_length(?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) v LEFT JOIN objects o ON o.id = json_extract(v.value,'$.id') AND o.markaz_id = ? WHERE o.updated_at IS NOT json_extract(v.value,'$.updatedAt'))
        THEN ? ELSE 'stale' END`).bind(target.id,markazId,expectedUpdatedAt,jamaat.id,markazId,jamaatUpdatedAt,markazId,jamaat.id,versionJson,versionJson,markazId,guardId);
      try{
        await db.batch([guard,...changes.map(change=>db.prepare("UPDATE objects SET title = ?,start_at = ?,end_at = ?,status = ?,data = ?,updated_at = ? WHERE id = ? AND markaz_id = ?").bind(change.title,change.startAt,change.endAt,change.status,JSON.stringify(change.data),stamp,change.id,markazId)),db.prepare("DELETE FROM route_assert WHERE id = ?").bind(guardId),auditChange("route.save",String(target.id))]);
      }catch(error){
        if(/route_assert_not_stale|CHECK constraint failed.*route_assert/.test(String(error)))return fail("This route changed while you were editing. Reload and review it before saving.",409);
        logOperationalError("saveRoute batch",error);
        return fail("The linked route could not be saved. Nothing was changed.",503);
      }
      return NextResponse.json({ok:true,changed:changes.map(change=>change.id)});
    }
    if(action==="repairLegacyAssignment"){
      if(!leader)return fail("Only Markaz leaders can review historical duties.",403);
      const reviewId=clean(body.reviewId,160),review=await db.prepare("SELECT * FROM repair_reviews WHERE id=? AND markaz_id=? AND kind IN ('invalid-assignment','legacy-assignment') AND status='needs-review'").bind(reviewId,markazId).first<Row>();
      if(!review)return fail("Duty review not found.",404);
      const assignment=await object(review.target_id);
      if(!assignment||assignment.kind!=="assignment")return fail("Historical duty not found.",404);
      if(body.expectedUpdatedAt!==assignment.updated_at)return fail("This duty changed. Reload and review it.",409);
      const resolution=body.resolution;
      if(resolution!=="correct"&&resolution!=="retain-history")return fail("Choose a duty review outcome.");
      let updated=data(assignment.data),status=String(assignment.status);
      if(resolution==="correct"){
        const jamaat=await object(assignment.parent_id),day=clean(body.date,10),selected=clean(body.personId,80);
        if(!jamaat||jamaat.kind!=="jamaat"||!isCivilDate(day)||day<String(jamaat.start_at).slice(0,10)||day>String(jamaat.end_at).slice(0,10))return fail("Choose a valid day within this Jamaat's trip.");
        if(selected&&!(await db.prepare("SELECT 1 FROM memberships WHERE jamaat_id=? AND person_id=? AND markaz_id=?").bind(jamaat.id,selected,markazId).first<Row>()))return fail("Choose a current member of this Jamaat.");
        updated={...updated,date:day,personId:selected||null,needsAssignmentReview:false};status="planned";
      }else status="historical";
      const guardId=id(),stamp=now()===assignment.updated_at?new Date(Date.parse(now())+1).toISOString():now();
      const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? AND (SELECT status FROM repair_reviews WHERE id=? AND markaz_id=?)='needs-review' THEN ? ELSE 'stale' END").bind(assignment.id,markazId,assignment.updated_at,reviewId,markazId,guardId);
      try{await db.batch([guard,db.prepare("UPDATE objects SET status=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(status,JSON.stringify(updated),stamp,assignment.id,markazId),db.prepare("UPDATE repair_reviews SET status=? WHERE id=? AND markaz_id=?").bind(resolution==="correct"?"corrected":"kept-historical",reviewId,markazId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("assignment.review."+resolution,String(assignment.id))]);}
      catch{return fail("This duty review changed during saving. Reload it.",409);}
      return NextResponse.json({ok:true,resolution});
    }
    if(action==="editMashwaraSettings"){
      const target=await object(body.id);
      if(!target||target.kind!=="mashwara")return fail("Mashwara not found.",404);
      if(!(await canPlanMashwara(target)))return fail("Only Mashwara planners can edit this meeting.",403);
      if(["weekly","monthly"].includes(String(data(target.data).recurrence)))return fail("Use the series editor to choose the edit scope.",409);
      if(body.expectedUpdatedAt!==target.updated_at)return fail("This meeting changed. Reload and review it.",409);
      const daily=data(target.data).daily===true,title=clean(body.title,160),details=clean(body.details,2000),status=clean(body.status,20),type=clean(body.type,30),visibility=clean(body.visibility,20),ameerId=clean(body.ameerId,80),locationId=clean(body.locationId,80);
      if(!title||!["planned","active","completed","cancelled"].includes(status)||!ameerId)return fail("Choose a meeting name, state and Mashwara Ameer.");
      if(!daily&&(!["general","weekly","halaqa","national","jamaat"].includes(type)||!["markaz","private"].includes(visibility)))return fail("Choose valid meeting settings.");
      if(daily&&!(await db.prepare("SELECT 1 FROM memberships WHERE jamaat_id=? AND person_id=? AND markaz_id=?").bind(target.parent_id,ameerId,markazId).first<Row>()))return fail("Daily Mashwara Ameer must belong to this Jamaat.");
      if(!daily&&!(await personInMarkaz(ameerId)))return fail("Choose a person from this Markaz.");
      const place=locationId?await object(locationId):null;
      if(locationId&&(!place||place.kind!=="place"||place.status==="archived"))return fail("Choose an active place from this Markaz.");
      let startAt=String(target.start_at||"");
      if(!daily){const parsed=parseOffsetInstant(body.startAt);if(!parsed)return fail("Choose a valid timed meeting start.");startAt=parsed;}
      const stamp=now()===target.updated_at?new Date(Date.parse(now())+1).toISOString():now(),guardId=id();
      const fields={...data(target.data),ameerId,locationId:locationId||null,details,...(daily?{}:{type,visibility})};
      const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(target.id,markazId,target.updated_at,guardId);
      try{await db.batch([guard,db.prepare("UPDATE objects SET title=?,start_at=?,status=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(title,startAt,status,JSON.stringify(fields),stamp,target.id,markazId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("mashwara.settings",String(target.id))]);}catch{return fail("This meeting changed during saving. Reload and review it.",409);}
      return NextResponse.json({ok:true});
    }
    if(action==="editMashwaraSeries"){
      const allowed=["action","id","scope","expectedUpdatedAt","expectedSeriesVersion","title","startAt","frequency","timeZone","type","ameerId","locationId","visibility","details","status","seriesEndCount","seriesEndDay"];
      if(Object.keys(body).some(key=>!allowed.includes(key)))return fail("Unexpected series field.");
      const target=await object(body.id);
      if(!target||target.kind!=="mashwara"||data(target.data).daily===true)return fail("Recurring Mashwara not found.",404);
      if(!(await canPlanMashwara(target)))return fail("Only Mashwara planners can edit this series.",403);
      const seriesId=clean(data(target.data).seriesId,80);
      const series=seriesId?await db.prepare("SELECT * FROM mashwara_series WHERE id=? AND markaz_id=?").bind(seriesId,markazId).first<Row>():null;
      const occurrence=series?await db.prepare("SELECT position FROM mashwara_occurrences WHERE series_id=? AND object_id=?").bind(seriesId,target.id).first<Row>():null;
      if(!series||!occurrence)return fail("This Mashwara has no editable recurrence series.",409);
      if(body.expectedUpdatedAt!==target.updated_at||body.expectedSeriesVersion!==series.version)return fail("This series changed. Reload and review it.",409);
      const scope=body.scope;
      if(!["one","future","all"].includes(String(scope)))return fail("Choose one meeting, future meetings, or the whole series.");
      const startAt=parseOffsetInstant(body.startAt),timeZone=clean(body.timeZone,100),frequency=clean(body.frequency,20),title=clean(body.title,160),type=clean(body.type,30),visibility=clean(body.visibility,20);
      if(!startAt||!isIanaTimeZone(timeZone)||!title||!["weekly","monthly"].includes(frequency)||!["general","weekly","halaqa","national","jamaat"].includes(type)||!["markaz","private"].includes(visibility))return fail("Choose valid series settings and a timed start.");
      const ameerId=clean(body.ameerId,80),locationId=clean(body.locationId,80);
      if(!ameerId||!(await personInMarkaz(ameerId)))return fail("Choose a Mashwara Ameer from this Markaz.");
      if(locationId&&(!(await object(locationId))||(await object(locationId))?.kind!=="place"||(await object(locationId))?.status==="archived"))return fail("Choose an active place from this Markaz.");
      if(typeof body.details!=="string"||body.details.length>2000)return fail("Planning notes are too long.");
      const status=clean(body.status,20)||String(target.status);
      if(!["planned","active","completed","cancelled"].includes(status))return fail("Choose a valid meeting state.");
      const endCount=body.seriesEndCount===null||body.seriesEndCount===undefined?null:body.seriesEndCount;
      const endDay=body.seriesEndDay===null||body.seriesEndDay===undefined||body.seriesEndDay===""?null:body.seriesEndDay;
      if(endCount!==null&&(!Number.isInteger(endCount)||Number(endCount)<1||Number(endCount)>520)||endDay!==null&&!isCivilDate(endDay)||endCount!==null&&endDay!==null)return fail("Choose one valid series end condition.");
      const position=Number(occurrence.position),cut=scope==="all"?0:position,stamp=now(),newVersion=id(),guardId=id();
      const startLocal=localDateTimeInput(startAt,timeZone),previousLocal=localDateTimeInput(String(target.start_at),timeZone);
      const priorAnchor=Number(data(target.data).monthAnchorDay||localDateTimeInput(String(series.anchor_instant),String(series.time_zone)).slice(8,10));
      const monthAnchorDay=scope==="one"?priorAnchor:scope==="future"&&frequency==="monthly"&&data(target.data).recurrence==="monthly"&&timeZone===scheduleZone(data(target.data).timeZone||series.time_zone)&&startLocal.slice(0,10)===previousLocal.slice(0,10)?priorAnchor:Number(startLocal.slice(8,10));
      const fields={...data(target.data),type,ameerId,locationId:locationId||null,visibility,details:body.details,timeZone,recurrence:frequency,seriesId,monthAnchorDay};
      const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT version FROM mashwara_series WHERE id=? AND markaz_id=?)=? AND (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(seriesId,markazId,series.version,target.id,markazId,target.updated_at,guardId);
      if(scope==="one"){
        const oneData={...fields,occurrence:position+1};
        try{await db.batch([guard,db.prepare("UPDATE objects SET title=?,start_at=?,status=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(title,startAt,status,JSON.stringify(oneData),stamp,target.id,markazId),db.prepare("UPDATE mashwara_occurrences SET exception=1 WHERE series_id=? AND position=?").bind(seriesId,position),db.prepare("UPDATE mashwara_series SET version=?,updated_at=? WHERE id=?").bind(newVersion,stamp,seriesId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("mashwara.series.one",String(target.id))]);}catch{return fail("This series changed during saving. Reload and review it.",409);}
        return NextResponse.json({ok:true,scope});
      }
      const changedRows=(await db.prepare("SELECT o.*,p.position,p.exception FROM mashwara_occurrences p JOIN objects o ON o.id=p.object_id WHERE p.series_id=? AND p.position>=? ORDER BY p.position").bind(seriesId,cut).all<Row>()).results;
      const writes:ReturnType<typeof db.prepare>[]=[];
      const rule:RecurrenceRule={anchorInstant:startAt,timeZone,frequency:frequency as RecurrenceRule["frequency"],endCount:endCount===null?null:Number(endCount)-cut,endDay:endDay===null?null:String(endDay),monthlyAnchorDay:monthAnchorDay};
      if(endCount!==null&&Number(endCount)<=cut||!seriesOccurrence(rule,0))return fail("The series end must include the selected meeting.");
      for(const row of changedRows){
        if(Number(row.exception)===1||Date.parse(String(row.start_at))<Date.now())continue;
        const protectedChild=await db.prepare("SELECT 1 FROM objects u WHERE u.parent_id=? AND u.markaz_id=? AND (u.kind IN ('attendee','suggestion','opinion') OR u.kind='umoor' AND (u.status='done' OR COALESCE(json_extract(u.data,'$.decision'),'')<>'' OR COALESCE(json_extract(u.data,'$.followUp'),'')<>'' OR EXISTS (SELECT 1 FROM objects opinion WHERE opinion.parent_id=u.id AND opinion.kind='opinion'))) LIMIT 1").bind(row.id,markazId).first<Row>();
        if(protectedChild||row.status!=="planned"){writes.push(db.prepare("UPDATE mashwara_occurrences SET exception=1 WHERE series_id=? AND position=?").bind(seriesId,row.position));continue;}
        const next=seriesOccurrence(rule,Number(row.position)-cut);
        const rowData={...data(row.data),...fields,occurrence:Number(row.position)+1};
        // A sibling may gain proceedings after preflight without changing the
        // series version. Check live child state and row version at the write.
        writes.push(db.prepare("UPDATE objects SET title=?,start_at=?,status=?,data=?,updated_at=? WHERE id=? AND markaz_id=? AND updated_at=? AND status='planned' AND NOT EXISTS (SELECT 1 FROM objects u WHERE u.parent_id=objects.id AND u.markaz_id=objects.markaz_id AND (u.kind IN ('attendee','suggestion','opinion') OR u.kind='umoor' AND (u.status='done' OR COALESCE(json_extract(u.data,'$.decision'),'')<>'' OR COALESCE(json_extract(u.data,'$.followUp'),'')<>'' OR EXISTS (SELECT 1 FROM objects opinion WHERE opinion.parent_id=u.id AND opinion.kind='opinion'))))").bind(title,next?.instant||row.start_at,next?"planned":"cancelled",JSON.stringify(rowData),stamp,row.id,markazId,row.updated_at));
      }
      const segmentId=id();
      const seriesUpdates=scope==="all"?db.prepare("UPDATE mashwara_series SET anchor_instant=?,time_zone=?,frequency=?,end_count=?,end_day=?,title=?,template_data=?,version=?,updated_at=? WHERE id=?").bind(startAt,timeZone,frequency,endCount,endDay,title,JSON.stringify(fields),newVersion,stamp,seriesId):db.prepare("UPDATE mashwara_series SET end_count=?,end_day=?,version=?,updated_at=? WHERE id=?").bind(endCount,endDay,newVersion,stamp,seriesId);
      try{await db.batch([guard,db.prepare("DELETE FROM mashwara_series_changes WHERE series_id=? AND start_index>=?").bind(seriesId,cut),db.prepare("INSERT INTO mashwara_series_changes (id,series_id,start_index,anchor_instant,time_zone,frequency,title,template_data,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(segmentId,seriesId,cut,startAt,timeZone,frequency,title,JSON.stringify(fields),stamp),seriesUpdates,...writes,db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("mashwara.series."+scope,seriesId)]);}catch{return fail("This series changed during saving. Reload and review it.",409);}
      return NextResponse.json({ok:true,scope,updated:writes.length});
    }
    if(action==="editRecurringUmoor"){
      const allowed=["action","umoorId","scope","expectedUpdatedAt","expectedSeriesVersion","title","notes"];
      if(Object.keys(body).some(key=>!allowed.includes(key)))return fail("Unexpected recurring umoor field.");
      const umoor=await object(body.umoorId),meeting=umoor?.kind==="umoor"?await object(umoor.parent_id):null;
      if(!umoor||!meeting||meeting.kind!=="mashwara"||data(umoor.data).recurring!==true)return fail("Recurring umoor not found.",404);
      if(!(await canPlanMashwara(meeting)))return fail("Only Mashwara planners can edit recurring umoor.",403);
      const seriesId=clean(data(meeting.data).seriesId,80),templateId=clean(data(umoor.data).templateId,80);
      const series=seriesId?await db.prepare("SELECT * FROM mashwara_series WHERE id=? AND markaz_id=?").bind(seriesId,markazId).first<Row>():null;
      const occurrence=series?await db.prepare("SELECT position FROM mashwara_occurrences WHERE series_id=? AND object_id=?").bind(seriesId,meeting.id).first<Row>():null;
      const template=templateId?await db.prepare("SELECT * FROM mashwara_umoor_templates WHERE id=? AND series_id=?").bind(templateId,seriesId).first<Row>():null;
      if(!series||!occurrence||!template)return fail("This recurring agenda needs review before editing.",409);
      if(body.expectedUpdatedAt!==umoor.updated_at||body.expectedSeriesVersion!==series.version)return fail("The recurring agenda changed. Reload and review it.",409);
      const scope=body.scope,title=clean(body.title,250);
      if(!["one","future","all"].includes(String(scope))||!title||typeof body.notes!=="string"||body.notes.length>2000)return fail("Choose an edit scope, title and valid notes.");
      const stamp=now(),newVersion=id(),guardId=id();
      const guard=db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT version FROM mashwara_series WHERE id=? AND markaz_id=?)=? AND (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(seriesId,markazId,series.version,umoor.id,markazId,umoor.updated_at,guardId);
      if(scope==="one"){
        try{await db.batch([guard,db.prepare("UPDATE objects SET title=?,data=json_set(data,'$.notes',?,'$.umoorException',json('true')),updated_at=? WHERE id=? AND markaz_id=? AND updated_at=?").bind(title,body.notes,stamp,umoor.id,markazId,umoor.updated_at),db.prepare("UPDATE mashwara_series SET version=?,updated_at=? WHERE id=?").bind(newVersion,stamp,seriesId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("umoor.series.one",String(umoor.id))]);}catch{return fail("The recurring agenda changed during saving. Reload and review it.",409);}
        return NextResponse.json({ok:true,scope});
      }
      const rootTemplateId=templateId.split("~")[0];
      const lineage=(await db.prepare("SELECT * FROM mashwara_umoor_templates WHERE series_id=?").bind(seriesId).all<Row>()).results.filter(row=>String(row.id)===rootTemplateId||String(row.id).startsWith(rootTemplateId+"~"));
      const rootTemplate=lineage.find(row=>String(row.id)===rootTemplateId);
      if(!rootTemplate)return fail("This recurring agenda needs review before editing.",409);
      const cut=scope==="all"?Number(rootTemplate.start_index):Number(occurrence.position);
      const active=scope==="all"?rootTemplate:[...lineage].sort((a,b)=>Number(b.start_index)-Number(a.start_index)).find(row=>Number(row.start_index)<=cut&&(row.end_index===null||Number(row.end_index)>=cut));
      if(!active)return fail("This recurring agenda needs review before editing.",409);
      const lineageIds=new Set(lineage.map(row=>String(row.id)));
      const copies=(await db.prepare("SELECT u.*,p.position,m.start_at AS meeting_start FROM objects u JOIN mashwara_occurrences p ON p.object_id=u.parent_id JOIN objects m ON m.id=p.object_id WHERE p.series_id=? AND p.position>=? AND u.kind='umoor' AND json_valid(u.data) ORDER BY p.position").bind(seriesId,cut).all<Row>()).results.filter(row=>lineageIds.has(String(data(row.data).templateId)));
      const split=scope==="future"&&cut>Number(active.start_index),newTemplateId=split?rootTemplateId+"~"+id():String(active.id);
      const writes:ReturnType<typeof db.prepare>[]=[];
      if(split){
        writes.push(db.prepare("UPDATE mashwara_umoor_templates SET end_index=?,version=? WHERE id=? AND series_id=?").bind(cut-1,id(),active.id,seriesId));
        writes.push(db.prepare("INSERT INTO mashwara_umoor_templates (id,series_id,start_index,end_index,title,notes,created_by,version) VALUES (?,?,?,?,?,?,?,?)").bind(newTemplateId,seriesId,cut,null,title,body.notes,person.id,id()));
      }else writes.push(db.prepare("UPDATE mashwara_umoor_templates SET title=?,notes=?,end_index=NULL,version=? WHERE id=? AND series_id=?").bind(title,body.notes,id(),active.id,seriesId));
      for(const later of lineage.filter(row=>String(row.id)!==String(active.id)&&Number(row.start_index)>=cut))writes.push(db.prepare("UPDATE mashwara_umoor_templates SET end_index=start_index-1,version=? WHERE id=? AND series_id=?").bind(id(),later.id,seriesId));
      for(const copy of copies){
        if(Date.parse(String(copy.meeting_start))<Date.now()||data(copy.data).umoorException===true||copy.status==="done"||clean(data(copy.data).decision)||clean(data(copy.data).followUp))continue;
        const opinions=await db.prepare("SELECT 1 FROM objects WHERE parent_id=? AND kind='opinion' LIMIT 1").bind(copy.id).first<Row>();
        if(opinions)continue;
        // Merge planning fields into live JSON, never a preflight copy of a
        // decision. Opinions do not bump the agenda row, so check them in SQL.
        writes.push(db.prepare("UPDATE objects SET title=?,data=json_set(data,'$.notes',?,'$.templateId',?),updated_at=? WHERE id=? AND markaz_id=? AND updated_at=? AND status<>'done' AND COALESCE(json_extract(data,'$.decision'),'')='' AND COALESCE(json_extract(data,'$.followUp'),'')='' AND COALESCE(json_extract(data,'$.umoorException'),0)<>1 AND NOT EXISTS (SELECT 1 FROM objects opinion WHERE opinion.parent_id=objects.id AND opinion.markaz_id=objects.markaz_id AND opinion.kind='opinion') AND EXISTS (SELECT 1 FROM objects meeting WHERE meeting.id=objects.parent_id AND meeting.markaz_id=objects.markaz_id AND meeting.start_at>=? AND meeting.status IN ('planned','active'))").bind(title,body.notes,newTemplateId,stamp,copy.id,markazId,copy.updated_at,stamp));
      }
      try{await db.batch([guard,...writes,db.prepare("UPDATE mashwara_series SET version=?,updated_at=? WHERE id=?").bind(newVersion,stamp,seriesId),db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("umoor.series."+scope,seriesId)]);}catch{return fail("The recurring agenda changed during saving. Reload and review it.",409);}
      return NextResponse.json({ok:true,scope,updated:writes.length-(split?2:1)});
    }
    if (action === "editEventTeam") {
      if (Object.keys(body).some(key=>!["action","teamId","expectedUpdatedAt","title","details","personId"].includes(key))) return fail("Unsupported team field.");
      const team=await object(body.teamId), event=team?.kind==="team"?await object(team.parent_id):null;
      if (!team || !event || event.kind!=="event") return fail("Team not found.",404);
      const teamAmeer=data(team.data).personId===person.id;
      if (!leader && !teamAmeer) return fail("You cannot edit this team.",403);
      if (!leader && Object.hasOwn(body,"personId")) return fail("Only Markaz leadership can appoint a team Ameer.",403);
      if (event.status==="completed" || event.status==="cancelled") return fail("This event is closed to team changes.",409);
      if (body.expectedUpdatedAt!==team.updated_at) return fail("This team changed. Reload and try again.",409);
      const title=clean(body.title,200), details=clean(body.details,1000);
      if (!title || typeof body.title!=="string" || body.title.length>200 || typeof body.details!=="string" || body.details.length>1000) return fail("Enter a team name and instructions within the allowed length.");
      const selected=leader&&Object.hasOwn(body,"personId")?clean(body.personId,80):String(data(team.data).personId||"");
      if (selected && !(await personInMarkaz(selected))) return fail("Choose a person from this Markaz.");
      const stamp=nextStamp(team.updated_at), guardId=id();
      try { await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM objects t JOIN objects e ON e.id=t.parent_id AND e.markaz_id=t.markaz_id WHERE t.id=? AND t.markaz_id=? AND t.kind='team' AND t.updated_at=? AND e.kind='event' AND e.status IN ('planned','active') AND (?=1 OR json_extract(t.data,'$.personId')=?)) THEN ? ELSE 'stale' END").bind(team.id,markazId,team.updated_at,leader?1:0,person.id,guardId),
        db.prepare("UPDATE objects SET title=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(title,JSON.stringify({...data(team.data),personId:selected||null,details}),stamp,team.id,markazId),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("team.update",String(team.id))
      ]); } catch { return fail("The team or event changed while saving. Reload and try again.",409); }
      return NextResponse.json({ok:true});
    }
    if (action === "saveEventDuty") {
      if (Object.keys(body).some(key=>!["action","dutyId","expectedUpdatedAt","status","title","details","personId","dueAt"].includes(key))) return fail("Unsupported duty field.");
      const duty=await object(body.dutyId), team=duty?.kind==="duty"?await object(duty.parent_id):null, event=team?.kind==="team"?await object(team.parent_id):null;
      if (!duty || !team || !event || event.kind!=="event") return fail("Duty not found.",404);
      const manager=leader||data(team.data).personId===person.id;
      const assignee=data(duty.data).personId===person.id;
      if (!manager && !assignee) return fail("You cannot change this duty.",403);
      if (!manager && ["title","details","personId","dueAt"].some(key=>Object.hasOwn(body,key))) return fail("Assignees can update only their own duty progress.",403);
      if (event.status==="completed" || event.status==="cancelled") return fail("This event is closed to duty changes.",409);
      if (body.expectedUpdatedAt!==duty.updated_at) return fail("This duty changed. Reload and try again.",409);
      if (typeof body.status!=="string" || !["open","in-progress","done"].includes(body.status)) return fail("Choose a valid duty status.");
      let title=String(duty.title), fields={...data(duty.data)};
      if (manager) {
        if (Object.hasOwn(body,"title")) { if (typeof body.title!=="string" || !body.title.trim() || body.title.length>200) return fail("Enter a duty name."); title=body.title.trim(); }
        if (Object.hasOwn(body,"details")) { if (typeof body.details!=="string" || body.details.length>1000) return fail("Duty details are too long."); fields.details=body.details.trim(); }
        if (Object.hasOwn(body,"personId")) { const selected=clean(body.personId,80); if (selected && !(await personInMarkaz(selected))) return fail("Choose a person from this Markaz."); fields.personId=selected||null; }
        if (Object.hasOwn(body,"dueAt")) { const dueAt=body.dueAt?parseOffsetInstant(body.dueAt):null; if (body.dueAt&&!dueAt) return fail("Choose a valid duty due date and time."); if (dueAt) { const zone=scheduleZone(data(event.data).timeZone||markazZone),day=localDay(dueAt,zone); if (!day || day<localDay(String(event.start_at),zone)! || day>localDay(String(event.end_at),zone)!) return fail("Duty due time must fall on an event day."); } fields.dueAt=dueAt; }
      }
      const stamp=nextStamp(duty.updated_at);
      if (body.status!==duty.status) { fields.progressBy=person.id;fields.progressAt=stamp; }
      if (body.status==="done") { if (duty.status!=="done") {fields.completedBy=person.id;fields.completedAt=stamp;} }
      else { fields.completedBy=null;fields.completedAt=null; }
      const guardId=id();
      try { await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN EXISTS (SELECT 1 FROM objects d JOIN objects t ON t.id=d.parent_id AND t.markaz_id=d.markaz_id JOIN objects e ON e.id=t.parent_id AND e.markaz_id=d.markaz_id WHERE d.id=? AND d.markaz_id=? AND d.kind='duty' AND d.updated_at=? AND t.kind='team' AND e.kind='event' AND e.status IN ('planned','active') AND (?=1 OR (?=1 AND json_extract(t.data,'$.personId')=?) OR (?=1 AND json_extract(d.data,'$.personId')=?))) THEN ? ELSE 'stale' END").bind(duty.id,markazId,duty.updated_at,leader?1:0,manager&&!leader?1:0,person.id,!manager?1:0,person.id,guardId),
        db.prepare("UPDATE objects SET title=?,status=?,data=?,updated_at=? WHERE id=? AND markaz_id=?").bind(title,body.status,JSON.stringify(fields),stamp,duty.id,markazId),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("duty.update",String(duty.id))
      ]); } catch { return fail("The duty, team or event changed while saving. Reload and try again.",409); }
      return NextResponse.json({ok:true});
    }
    if (action === "updateItem") {
      if (typeof body.id !== "string" || !body.id || body.id.length > 80) return fail("Choose a valid item.");
      const item = await object(body.id);
      if (!item) return fail("Item not found.",404);
      if(item.kind==="place"&&item.status==="archived")return fail("Archived places cannot be edited. Review their merged destination.",409);
      if (item.kind==="team" || item.kind==="duty") return fail("Use the team or duty controls for this event.",409);
      if (item.kind==="money") return fail("Use a Baraka correction or reversal; the original entry remains in history.",409);
      let permitted = leader;
      const parent = item.parent_id ? await object(item.parent_id) : null;
      if (!permitted && item.kind === "jamaat") permitted = await hasJamaatScope(item,"route");
      if (!permitted && ["stay","assignment","note","money","tashkil","message","incident","masjid_note"].includes(String(item.kind))) {
        const j = item.kind === "masjid_note" ? await object(data(item.data).jamaatId) : parent;
        const required: JamaatScope = item.kind === "assignment" ? "amaal" : item.kind === "note" || item.kind === "masjid_note" ? "notes" : item.kind === "money" ? "funds" : item.kind === "tashkil" ? "tashkil" : item.kind === "incident" ? "incidents" : "route";
        permitted = !!j && j.kind === "jamaat" && (item.kind === "message" && item.created_by === person.id ? !!(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(j.id,person.id,markazId).first<Row>()) : await hasJamaatScope(j,required));
      }
      if (!permitted && item.kind === "mashwara") permitted = await canPlanMashwara(item);
      if (!permitted && ["umoor","suggestion","opinion"].includes(String(item.kind)) && parent) {
        const m = parent.kind === "mashwara" ? parent : await object(parent.parent_id);
        permitted = !!m && await canPlanMashwara(m);
      }
      if (!permitted) return fail("You cannot edit this item.",403);
      if (item.kind === "assignment" && data(item.data).mashwaraId) return fail("Update this assignment in its daily Mashwara so the day plan stays together.");
      if(item.kind==="assignment"&&(item.status==="historical"||await db.prepare("SELECT 1 FROM repair_reviews WHERE markaz_id=? AND target_id=? AND kind IN ('invalid-assignment','legacy-assignment') AND status='needs-review'").bind(markazId,item.id).first<Row>()))return fail("Review this historical duty before changing it.",409);
      const input = updateItemInput(body,String(item.kind),item);
      if (typeof body.expectedUpdatedAt !== "string" || !body.expectedUpdatedAt || body.expectedUpdatedAt !== item.updated_at) return fail("This record changed. Review the latest version before saving.",409);
      if (["note","tashkil","masjid_note","incident"].includes(String(item.kind))) return fail("Use the record correction form so its history is preserved.",409);
      const {title,start,end,status,patch} = input;
      if(item.kind==="mashwara"&&["weekly","monthly"].includes(String(data(item.data).recurrence))&&await db.prepare("SELECT id FROM mashwara_series WHERE id=? AND markaz_id=?").bind(data(item.data).seriesId,markazId).first<Row>())return fail("Use the series editor to choose one meeting or future meetings.",409);
      if(item.kind==="stay") return fail("Use the stay route editor to review linked plans and host arrangements.",409);
      if(["jamaat","stay"].includes(String(item.kind))&&(start!==item.start_at||end!==item.end_at)) return fail("Use the route editor to choose how linked plans move.",409);
      if (item.kind === "mashwara" && data(item.data).daily === true && (start !== item.start_at || end !== item.end_at)) return fail("A daily Mashwara stays on its Jamaat day. Add a daily Mashwara for the other day instead.");
      const current = data(item.data);
      for (const [key,value] of Object.entries(patch)) {
        if (key === "personId" || key === "locationId") {
          const selected = String(value || "");
          if (selected) {
            const reference = key === "personId" ? await personInMarkaz(selected) : await object(selected);
            if (!reference || (key === "locationId" && (reference.kind !== "place"||reference.status==="archived"))) return fail("Choose a valid person or active place.");
            if (key === "personId" && item.kind === "assignment" && !(await db.prepare("SELECT id FROM memberships WHERE jamaat_id = ? AND person_id = ? AND markaz_id = ?").bind(item.parent_id,selected,markazId).first<Row>())) return fail("Choose a member of this Jamaat.");
          }
          current[key] = selected || null;
        } else current[key] = value;
      }
      if(item.kind==="assignment"){
        if(!parent||parent.kind!=="jamaat")return fail("Jamaat not found.",404);
        const dutyDay=String(current.date||"");
        if(!isCivilDate(dutyDay)||dutyDay<String(parent.start_at).slice(0,10)||dutyDay>String(parent.end_at).slice(0,10))return fail("Choose an assignment day within this Jamaat's trip.");
        if(current.personId&&!(await db.prepare("SELECT 1 FROM memberships WHERE jamaat_id=? AND person_id=? AND markaz_id=?").bind(parent.id,current.personId,markazId).first<Row>()))return fail("Choose a current member of this Jamaat.");
      }
      if (item.kind==="event" && status==="completed") {
        const unfinished=await db.prepare("SELECT 1 FROM objects d JOIN objects t ON t.id=d.parent_id AND t.markaz_id=d.markaz_id WHERE t.parent_id=? AND t.kind='team' AND d.kind='duty' AND d.markaz_id=? AND d.status<>'done' LIMIT 1").bind(item.id,markazId).first<Row>();
        if (unfinished) return fail("Complete or reassign open duties before closing this event.",409);
      }
      if (item.kind==="event" && status==="completed") {
        const guardId=id();
        try { await db.batch([
          db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? AND NOT EXISTS (SELECT 1 FROM objects d JOIN objects t ON t.id=d.parent_id AND t.markaz_id=d.markaz_id WHERE t.parent_id=? AND t.kind='team' AND d.kind='duty' AND d.markaz_id=? AND d.status<>'done') THEN ? ELSE 'stale' END").bind(item.id,markazId,body.expectedUpdatedAt,item.id,markazId,guardId),
          db.prepare("UPDATE objects SET title=?,start_at=?,end_at=?,status=?,data=?,updated_at=? WHERE id=? AND markaz_id=? AND updated_at=?").bind(title,start,end,status,JSON.stringify(current),nextStamp(item.updated_at),item.id,markazId,body.expectedUpdatedAt),
          db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),auditChange("event.update",String(item.id))
        ]); } catch { return fail("This event or its duties changed. Reload and review them.",409); }
        return NextResponse.json({ok:true});
      }
      const guardId=id();
      try { await db.batch([
        db.prepare("INSERT INTO route_assert (id) SELECT CASE WHEN (SELECT updated_at FROM objects WHERE id=? AND markaz_id=?)=? THEN ? ELSE 'stale' END").bind(item.id,markazId,body.expectedUpdatedAt,guardId),
        db.prepare("UPDATE objects SET title = ?, start_at = ?, end_at = ?, status = ?, data = ?, updated_at = ? WHERE id = ? AND markaz_id=? AND updated_at=?").bind(title,start,end,status,JSON.stringify(current),nextStamp(item.updated_at),item.id,markazId,body.expectedUpdatedAt),
        db.prepare("DELETE FROM route_assert WHERE id=?").bind(guardId),
        auditChange(String(item.kind)+".update",String(item.id))
      ]); } catch { return fail("This record changed. Review the latest version before saving.",409); }
      return NextResponse.json({ ok:true });
    }
    return fail("This action is not available yet.");
  } catch (error) {
    if (error instanceof InputError) return fail(error.message);
    logOperationalError("POST /api/app", error);
    return fail("The change could not be saved. Please try again.", 503);
  }
}
