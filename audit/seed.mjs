// Generates and optionally applies deterministic, entirely synthetic local data.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const personas = JSON.parse(readFileSync(new URL("./personas.json", import.meta.url), "utf8"));
const stamp = "2026-09-30T00:00:00.000Z";
const quote = value => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const statements = ["PRAGMA foreign_keys = OFF;", ...["audit","memberships","objects","people","markaz"].map(table => `DELETE FROM ${table};`)];
const insert = (table, row) => statements.push(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(quote).join(",")});`);
const person = (p, index) => {
  const other = p.key.startsWith("other-");
  insert("people", {id:p.personId,markaz_id:other?"markaz-other":"markaz-surrey",auth_id:p.authId,name:p.name,phone:p.key==="contacts"?null:`+1 604 555 ${String(100+index).padStart(4,"0")}`,email:p.key==="member"?null:p.email,role:p.key==="admin"||p.key==="other-admin"?"admin":p.key==="markaz-ameer"?"markaz_ameer":"worker",claimed_role:["ameer","pending","markaz-ameer"].includes(p.key)?"ameer":"worker",local_masjid_id:other?"place-other":"place-1",local_markaz_id:other?"place-other":"place-markaz",national_markaz_id:other?null:"place-national",created_at:stamp});
};
const object = (id,kind,title,data={},parentId=null,options={}) => insert("objects", {id,markaz_id:options.markazId||"markaz-surrey",kind,parent_id:parentId,title,start_at:options.start||null,end_at:options.end||null,status:options.status||"planned",data:JSON.stringify(data),created_by:options.createdBy||"p-admin",created_at:stamp,updated_at:stamp});
const membership = (jamaatId, personId, permissions={}, role="member", markazId="markaz-surrey") => insert("memberships",{id:`membership-${jamaatId}-${personId}`,markaz_id:markazId,jamaat_id:jamaatId,person_id:personId,role,permissions:JSON.stringify(permissions),created_at:stamp});

insert("markaz",{id:"markaz-surrey",name:"Surrey Audit Markaz — synthetic",join_code:"AUDIT-SURREY-2026",created_by:"audit-auth-admin",created_at:stamp});
insert("markaz",{id:"markaz-other",name:"Other Audit Markaz — synthetic",join_code:"AUDIT-OTHER-2026",created_by:"audit-auth-other-admin",created_at:stamp});
personas.filter(p=>p.personId).forEach(person);
insert("people",{id:"p-unlinked",markaz_id:"markaz-surrey",auth_id:null,name:"عبدالله / Abdullah — offline member",phone:null,email:null,role:"worker",claimed_role:"worker",created_at:stamp});

for (const [id,title,type,address] of [
  ["place-1","Audit Masjid One — Friday","masjid","100 Example Street, Surrey, BC"],
  ["place-2","Audit Musalla Two — Saturday","musalla","200 Example Street, Surrey, BC"],
  ["place-3","Audit Centre Three — Sunday","centre","300 Example Street, Surrey, BC"],
  ["place-markaz","Surrey Audit Markaz","markaz","400 Example Street, Surrey, BC"],
  ["place-national","National Audit Markaz","markaz","500 Example Street, Surrey, BC"]
]) object(id,"place",title,{type,address,source:"custom",hostPermission:"confirmed",notes:"Synthetic venue for local testing only."});
object("place-other","place","Other tenant masjid",{type:"masjid",address:"600 Example Street",notes:"TENANT_B_PLACE_CANARY"},null,{markazId:"markaz-other",createdBy:"p-other-admin"});

const route="Friday Masjid One → Saturday Musalla Two → Sunday Centre Three";
object("jamaat-weekend","jamaat","Surrey three-place weekend",{kind:"regular",route,ameerId:"p-ameer",ameerStatus:"approved",pendingAmeerId:null},null,{start:"2026-10-02",end:"2026-10-04",status:"ready",createdBy:"p-ameer"});
object("jamaat-pending","jamaat","Pending creator weekend",{kind:"regular",route,ameerId:null,ameerStatus:"pending",pendingAmeerId:"p-pending"},null,{start:"2026-10-02",end:"2026-10-04",status:"planning",createdBy:"p-pending"});
object("jamaat-mastooraat","jamaat","Mastooraat three-place weekend",{kind:"mastooraat",route,ameerId:"p-ameer",ameerStatus:"approved",pendingAmeerId:null},null,{start:"2026-10-02",end:"2026-10-04",status:"planning",createdBy:"p-ameer"});
object("jamaat-other","jamaat","Other Markaz private Jamaat",{kind:"regular",route:"TENANT_B_ROUTE_CANARY",ameerId:"p-other-admin",ameerStatus:"approved",pendingAmeerId:null},null,{markazId:"markaz-other",start:"2026-10-02",end:"2026-10-04",status:"ready",createdBy:"p-other-admin"});
membership("jamaat-weekend","p-ameer",{},"ameer");
membership("jamaat-weekend","p-member",{labels:["Khidmah"]});
membership("jamaat-weekend","p-planner",{manage:true,viewContacts:false,labels:["Responsible of Tashkil"]});
membership("jamaat-weekend","p-contacts",{manage:false,viewContacts:true,labels:["Responsible of Khidmah"]});
membership("jamaat-weekend","p-unlinked");
membership("jamaat-pending","p-pending");
membership("jamaat-pending","p-member");
membership("jamaat-mastooraat","p-ameer",{},"ameer");
membership("jamaat-mastooraat","p-planner",{manage:true,viewContacts:false,labels:["Daily planner"]});
membership("jamaat-mastooraat","p-member");
membership("jamaat-other","p-other-admin",{},"ameer","markaz-other");
membership("jamaat-other","p-other-markaz",{},"member","markaz-other");

for (let day=2;day<=4;day++) object(`stay-${day-1}`,"stay",["Friday arrival","Saturday transfer","Sunday return"][day-2],{placeId:`place-${day-1}`,hostStatus:day===2?"confirmed":"proposed",conditions:["Local brothers report evening Ta'leem and Friday Jawla.","Contact host before travel; entrance access needs confirmation.","Departure after Asr; return summary requested."][day-2]},"jamaat-weekend",{start:`2026-10-0${day}T${day===2?"17":"09"}:00:00-07:00`,end:`2026-10-0${day}T${day===4?"17":"23"}:00:00-07:00`,createdBy:"p-ameer"});
object("assignment-khidmah-1","assignment","Khidmah: first helper",{amal:"Khidmah",personId:"p-member",date:"2026-10-02",details:"Prepare meal together."},"jamaat-weekend",{createdBy:"p-ameer"});
object("assignment-khidmah-2","assignment","Khidmah: second helper",{amal:"Khidmah",personId:"p-contacts",date:"2026-10-02",details:"Assist first helper."},"jamaat-weekend",{createdBy:"p-ameer"});
object("assignment-fajr","assignment","Fajr Bayaan",{amal:"Fajr Bayaan",personId:null,date:"2026-10-03",details:"Assign in daily mashwara."},"jamaat-weekend",{createdBy:"p-ameer"});
object("note-weekend","note","Weekend planning notes",{category:"general",text:"PRIVATE_JAMAAT_NOTE_CANARY: synthetic leader note.",peopleTashkiled:2,jamaatsTashkiled:1},"jamaat-weekend",{createdBy:"p-ameer"});
object("money-collection","money","Friday Baraka collection",{type:"collection",amountCents:12500,date:"2026-10-02",note:"PRIVATE_BARAKA_CANARY: synthetic shared funds."},"jamaat-weekend",{createdBy:"p-ameer"});
object("money-expense","money","Friday groceries",{type:"expense",amountCents:3750,date:"2026-10-02",note:"Synthetic receipt reference R-001."},"jamaat-weekend",{createdBy:"p-ameer"});
object("tashkil-weekend","tashkil","Jawla intention",{context:"Jawla",intention:"3 days next month",personName:"Synthetic Visitor",note:"PRIVATE_TASHKIL_CANARY",followUp:"Ask permission before contact."},"jamaat-weekend",{createdBy:"p-ameer"});
object("message-weekend","message","Friday arrival message",{text:"Arrive at the first masjid at 5 pm. Please contact the Ameer if delayed.",authorId:"p-ameer"},"jamaat-weekend",{createdBy:"p-ameer"});
object("masjid-note-weekend","masjid_note","Local conditions at first masjid",{jamaatId:"jamaat-weekend",text:"PRIVATE_MASJID_NOTE_CANARY",localWork:"The local brothers requested a short evening Ta'leem."},"place-1",{createdBy:"p-ameer"});
object("incident-weekend","incident","Synthetic transport incident",{severity:"moderate",description:"INCIDENT_CANARY_PRIVATE: fictional minor vehicle issue; no real incident.",followUp:"Check alternative transport before departure.",reportedBy:"p-ameer"},"jamaat-weekend",{status:"open",createdBy:"p-ameer"});
object("incident-other","incident","Other tenant confidential incident",{severity:"serious",description:"TENANT_B_INCIDENT_CANARY",followUp:"Synthetic confidential follow-up.",reportedBy:"p-other-admin"},"jamaat-other",{markazId:"markaz-other",status:"open",createdBy:"p-other-admin"});

for (const [id,title,type,visibility] of [["mashwara-public","Weekly Markaz Mashwara","weekly","markaz"],["mashwara-private","Private planning Mashwara","general","private"],["mashwara-national","National coordination Mashwara","national","markaz"],["mashwara-halaqa","Halaqa Mashwara","halaqa","markaz"]]) object(id,"mashwara",title,{type,recurrence:id==="mashwara-public"?"weekly":"none",seriesId:id,occurrence:1,ameerId:"p-mashwara-ameer",locationId:"place-markaz",visibility,details:visibility==="private"?"PRIVATE_MASHWARA_CANARY":"Review weekend arrangements."},null,{start:"2026-10-02T20:00:00-07:00",createdBy:"p-admin"});
object("mashwara-public-next","mashwara","Weekly Markaz Mashwara",{type:"weekly",recurrence:"weekly",seriesId:"mashwara-public",occurrence:2,ameerId:"p-mashwara-ameer",locationId:"place-markaz",visibility:"markaz",details:"Next recurring occurrence."},null,{start:"2026-10-09T20:00:00-07:00",createdBy:"p-admin"});
object("collaborator-private","collaborator","Invited planning collaborator",{personId:"p-collaborator"},"mashwara-private");
object("collaborator-public","collaborator","Invited planning collaborator",{personId:"p-collaborator"},"mashwara-public");
object("umoor-public","umoor","Weekend route and Khidmah",{notes:"Discuss the three venues.",decision:"",followUp:"",recurring:true,seriesId:"mashwara-public"},"mashwara-public",{status:"open"});
object("umoor-private","umoor","Confidential planning matter",{notes:"PRIVATE_UMOOR_CANARY",decision:"",followUp:"",recurring:false,seriesId:"mashwara-private"},"mashwara-private",{status:"open"});
object("opinion-private","opinion","Opinion",{personId:"p-collaborator",note:"PRIVATE_OPINION_CANARY"},"umoor-private",{status:"recorded",createdBy:"p-collaborator"});
object("suggestion-public","suggestion","Consider transport accessibility",{personId:"p-member",note:"Allow more boarding time."},"mashwara-public",{status:"open",createdBy:"p-member"});
object("attendee-public","attendee","attendee",{personId:"p-member"},"mashwara-public",{status:"open",createdBy:"p-member"});
object("event-ijtema","event","Surrey Audit Ijtema",{type:"Ijtema",locationId:"place-3",details:"Synthetic event planning, Sunday afternoon."},null,{start:"2026-10-04T13:00:00-07:00",end:"2026-10-04T17:00:00-07:00"});
object("team-khidmah","team","Ijtema Khidmah team",{personId:"p-team-ameer",details:"Prepare and clean meal area."},"event-ijtema");
object("duty-water","duty","Set out water",{personId:"p-duty-member",details:"Complete before attendees arrive."},"team-khidmah",{status:"open"});

const sql = statements.join("\n")+"\n";
const path = fileURLToPath(new URL("./fixture.sql",import.meta.url));
writeFileSync(path,sql);
writeFileSync(new URL("./fixture-ids.json",import.meta.url),JSON.stringify({markaz:"markaz-surrey",otherMarkaz:"markaz-other",jamaat:"jamaat-weekend",pendingJamaat:"jamaat-pending",mastooraatJamaat:"jamaat-mastooraat",otherJamaat:"jamaat-other",places:["place-1","place-2","place-3"],mashwaras:{public:"mashwara-public",private:"mashwara-private",national:"mashwara-national",halaqa:"mashwara-halaqa"},umoor:{public:"umoor-public",private:"umoor-private"},event:"event-ijtema",team:"team-khidmah",duty:"duty-water",incident:"incident-weekend",otherIncident:"incident-other",weekend:{start:"2026-10-02",end:"2026-10-04",timezone:"America/Vancouver"}},null,2)+"\n");
if (process.argv.includes("--apply")) {
  const result=spawnSync(process.execPath,["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js","d1","execute","DB","--local","--config","dist/server/wrangler.json","--persist-to",".wrangler/audit-state","--file",path],{cwd:root,stdio:"inherit"});
  process.exit(result.status||0);
}
process.stdout.write(`Generated synthetic fixture: ${path}\nUse --apply only to reset the isolated audit database.\n`);
