export type VenueType="masjid"|"musalla"|"centre"|"markaz";
export type OSMElement={type:string;id:number;lat?:number;lon?:number;center?:{lat:number;lon:number};tags?:Record<string,string>};
export type DirectoryPlace={osmId:string;osmIds:string[];name:string;address:string;type:VenueType;lat:number;lon:number;source:"OpenStreetMap";checkedAt:string};

const clean=(value:unknown,max:number)=>typeof value==="string"?value.trim().slice(0,max):"";
export const surreyArea=(lat:number,lon:number)=>Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=49.0&&lat<=49.25&&lon>=-122.96&&lon<=-122.65;
export const outsideSurreyAddress=(address:string)=>/\b(?:delta|white rock|langley|new westminster|burnaby)\b/i.test(address);
export const venueType=(tags:Record<string,string>={}) : VenueType=>{
  const name=(tags.name||tags["name:en"]||"").toLowerCase();
  if (/\b(markaz|markaz centre)\b/.test(name)) return "markaz";
  if (/\b(musalla|musallah|mussala|prayer room|prayer space)\b/.test(name)) return "musalla";
  if (/\b(centre|center)\b/.test(name)&&!/\bmosque\b/.test(name)) return "centre";
  return "masjid";
};
const norm=(value:string)=>value.toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu,"").replace(/\b(masjid|mosque|musalla|musallah|centre|center)\b/g,"").replace(/[^a-z0-9]+/g,"");
const metres=(a:DirectoryPlace,b:DirectoryPlace)=>{
  const lat=(a.lat-b.lat)*111_000,lon=(a.lon-b.lon)*111_000*Math.cos(a.lat*Math.PI/180);
  return Math.hypot(lat,lon);
};
export function directoryPlaces(elements:OSMElement[],checkedAt:string):DirectoryPlace[] {
  const entries:DirectoryPlace[]=[];
  for(const element of elements){
    if(!["node","way","relation"].includes(element.type)||!Number.isSafeInteger(element.id)||element.id<1)continue;
    const lat=element.lat??element.center?.lat,lon=element.lon??element.center?.lon,tags=element.tags||{};
    if(typeof lat!=="number"||typeof lon!=="number"||!surreyArea(lat,lon))continue;
    if(tags["addr:city"]&&outsideSurreyAddress(tags["addr:city"].trim()))continue;
    const name=clean(tags.name||tags["name:en"]||"Unnamed prayer space",160);
    const address=clean([tags["addr:housenumber"],tags["addr:street"],tags["addr:city"]].filter(Boolean).join(" "),250);
    if(outsideSurreyAddress(address))continue;
    const candidate:DirectoryPlace={osmId:`${element.type}/${element.id}`,osmIds:[`${element.type}/${element.id}`],name,address,type:venueType(tags),lat,lon,source:"OpenStreetMap",checkedAt};
    const duplicate=entries.find(entry=>metres(entry,candidate)<=35&&(norm(entry.name)===norm(candidate.name)||!!entry.address&&norm(entry.address)===norm(candidate.address)));
    if(duplicate){duplicate.osmIds.push(candidate.osmId);if(duplicate.name==="Unnamed prayer space"&&candidate.name!==duplicate.name)duplicate.name=candidate.name;if(!duplicate.address&&candidate.address)duplicate.address=candidate.address;continue;}
    entries.push(candidate);
  }
  return entries.slice(0,250);
}

export function potentialDuplicate(a:{name:string;address:string;lat?:number;lon?:number},b:{name:string;address:string;lat?:number;lon?:number}):boolean {
  if(a.address&&b.address&&norm(a.address)===norm(b.address))return true;
  if(a.address&&b.address&&norm(a.address)!==norm(b.address)&&(!a.lat||!b.lat||!a.lon||!b.lon))return false;
  if(a.name&&b.name&&norm(a.name)===norm(b.name))return !a.lat||!b.lat||!a.lon||!b.lon||Math.hypot((a.lat-b.lat)*111_000,(a.lon-b.lon)*111_000*Math.cos(a.lat*Math.PI/180))<=100;
  return false;
}

export function resolveDirectory(outcomes:PromiseSettledResult<OSMElement[]>[],checkedAt:string,snapshotPlaces:DirectoryPlace[],snapshotAt:string){
  const successful=outcomes.filter((entry):entry is PromiseFulfilledResult<OSMElement[]>=>entry.status==="fulfilled");
  if(!successful.length)return {places:snapshotPlaces,state:"snapshot" as const,checkedAt,sourceAt:snapshotAt};
  const places=directoryPlaces(successful.flatMap(entry=>entry.value),checkedAt);
  return {places,state:successful.length===outcomes.length?(places.length?"live" as const:"empty" as const):"partial" as const,checkedAt,sourceAt:checkedAt};
}
