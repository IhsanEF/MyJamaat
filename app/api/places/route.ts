import { logOperationalError } from "@/lib/operational-log";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { NextResponse } from "next/server";
import snapshot from "@/data/surrey-osm.json";
import { outsideSurreyAddress, resolveDirectory, surreyArea, venueType, type DirectoryPlace, type OSMElement } from "@/lib/place-directory";
import { takeQuota } from "@/lib/abuse-controls";

export const dynamic = "force-dynamic";
type DirectoryResult={places:DirectoryPlace[];state:"live"|"partial"|"snapshot"|"empty";checkedAt:string;sourceAt:string;attribution:string;source:string};
let cached:{value:DirectoryResult;until:number}|null=null;
let pending:Promise<DirectoryResult>|null=null;
const source="https://www.openstreetmap.org/copyright";

async function lookup(query:string):Promise<OSMElement[]> {
  const response=await fetch("https://overpass-api.de/api/interpreter?data="+encodeURIComponent(query),{headers:{"user-agent":"MyJamaat/1.0 (Surrey community directory)"},signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error(`Overpass ${response.status}`);
  const payload=await response.json() as {elements?:OSMElement[]};
  if(!Array.isArray(payload.elements))throw new Error("Directory response missing elements.");
  return payload.elements;
}
async function freshDirectory():Promise<DirectoryResult> {
  const stamp=new Date().toISOString(),box="(49.0,-122.96,49.25,-122.65)";
  const nodes=`[out:json][timeout:12];node["amenity"="place_of_worship"]["religion"="muslim"]${box};out center tags;`;
  const other=`[out:json][timeout:12];(way["amenity"="place_of_worship"]["religion"="muslim"]${box};relation["amenity"="place_of_worship"]["religion"="muslim"]${box};);out center tags;`;
  const outcomes=await Promise.allSettled([lookup(nodes),lookup(other)]);
  const sourceAt=new Date(`${snapshot.retrievedAt}T00:00:00Z`).toISOString();
  const saved=snapshot.places.filter(place=>surreyArea(place.lat,place.lon)&&!outsideSurreyAddress(place.address)).map(place=>({osmId:place.osmId,osmIds:[place.osmId],name:place.name,address:place.address,type:venueType({name:place.name}),lat:place.lat,lon:place.lon,source:"OpenStreetMap" as const,checkedAt:sourceAt}));
  return {...resolveDirectory(outcomes,stamp,saved,sourceAt),attribution:"© OpenStreetMap contributors",source};
}
async function directory():Promise<DirectoryResult>{
  if(cached&&cached.until>Date.now())return cached.value;
  if(!pending)pending=freshDirectory().then(value=>{cached={value,until:Date.now()+(value.state==="live"||value.state==="empty"?3600000:600000)};return value;}).finally(()=>{pending=null;});
  return pending;
}

export async function GET() {
  try {
    const user=await getChatGPTUser();
    if(!user)return NextResponse.json({error:"Please sign in."},{status:401});
    if(!env.DB)throw new Error("Database unavailable");
    const person=await env.DB.prepare("SELECT id,markaz_id FROM people WHERE auth_id=?").bind(user.userId).first<{id:string;markaz_id:string}>();
    if(!person)return NextResponse.json({error:"Join a Markaz first."},{status:403});
    for(const [scope,subject] of [["user",user.userId],["tenant",person.markaz_id]] as const){
      const decision=await takeQuota(env.DB,"directory",scope,subject);
      if(!decision.allowed)return NextResponse.json({error:`The directory is being used often. Try again in ${decision.retryAfterSeconds} seconds.`},{status:429,headers:{"Retry-After":String(decision.retryAfterSeconds)}});
    }
    const fromCache=!!cached&&cached.until>Date.now();
    const result=await directory();
    const expiresAt=new Date(Date.now()+48*3600000).toISOString();
    for(const place of result.places){
      await env.DB.prepare("INSERT OR REPLACE INTO directory_candidates (osm_id,data_json,state,checked_at,expires_at) VALUES (?,?,?,?,?)").bind(place.osmId,JSON.stringify(place),result.state,result.sourceAt,expiresAt).run();
      for(const alias of place.osmIds.filter(id=>id!==place.osmId))await env.DB.prepare("INSERT OR REPLACE INTO directory_candidates (osm_id,data_json,state,checked_at,expires_at) VALUES (?,?,?,?,?)").bind(alias,JSON.stringify(place),result.state,result.sourceAt,expiresAt).run();
    }
    return NextResponse.json({...result,cached:fromCache});
  } catch(error) {
    logOperationalError("Surrey directory",error);
    return NextResponse.json({error:"The online directory is unavailable. You can still add a custom place.",state:"error"},{status:503});
  }
}
