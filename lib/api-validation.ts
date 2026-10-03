export class InputError extends Error {}
import { intervalValid, isCivilDate, isIanaTimeZone, parseOffsetInstant, temporalKind } from "./schedule-time";

export type Input = Record<string, unknown>;
export const plainObject = (value: unknown): value is Input => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function object(value: unknown, label: string): Input {
  if (!plainObject(value)) throw new InputError(`${label} must be a JSON object.`);
  return value;
}

function keys(value: Input, allowed: string[]) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new InputError(`Unsupported field: ${extra}.`);
}

function string(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InputError(`Enter ${label}.`);
    return "";
  }
  if (typeof value !== "string" || value.length > max) throw new InputError(`${label} must be text of at most ${max} characters.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new InputError(`Enter ${label}.`);
  return trimmed;
}

function choice(value: unknown, label: string, choices: string[], fallback?: string): string {
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new InputError(`Choose ${label}.`);
  }
  if (typeof value !== "string" || !choices.includes(value)) throw new InputError(`Choose a valid ${label}.`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new InputError(`Enter a valid ${label}.`);
  return value;
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InputError(`${label} must be true or false.`);
  return value;
}

function date(value: unknown, label: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InputError(`Choose ${label}.`);
    return null;
  }
  if (isCivilDate(value)) return value;
  const instant=parseOffsetInstant(value);
  if (instant) return instant;
  throw new InputError(`Choose a valid ${label}.`);
}

function interval(start: string | null, end: string | null) {
  if (start && end && !intervalValid(start,end)) throw new InputError("End must be after start, using the same date format.");
}

const enumFields: Record<string,string[]> = {
  jamaatKind:["regular","mastooraat"], placeType:["masjid","musalla","centre","markaz"], hostPermission:["unknown","allows-stay","visit-only","no"],
  hostStatus:["proposed","contacted","confirmed","arrived","completed"], moneyType:["collection","expense"],
  severity:["low","moderate","serious","critical"], eventType:["Ijtema","Mashwara","Other"],
  mashwaraType:["general","weekly","halaqa","national","jamaat"], recurrence:["none","weekly","monthly"], visibility:["markaz","private"],
};

type FieldRule = { type:"text"|"date"|"integer"|"choice"|"reference"; max?:number; choices?:string[]; min?:number; fallback?:unknown };
const text = (max:number):FieldRule => ({type:"text",max});
const ref:FieldRule = {type:"reference",max:80};
const when:FieldRule = {type:"date"};
const count:FieldRule = {type:"integer",min:0,max:100000,fallback:0};
const selected = (choices:string[],fallback?:string):FieldRule => ({type:"choice",choices,fallback});

const createFields: Record<string,Record<string,FieldRule>> = {
  place:{type:selected(enumFields.placeType,"masjid"),address:text(250),notes:text(1000)},
  stay:{placeId:ref,hostStatus:selected(enumFields.hostStatus,"proposed"),conditions:text(2000)},
  assignment:{amal:text(80),personId:ref,date:when,details:text(500)},
  note:{category:text(50),text:text(4000),peopleTashkiled:count,jamaatsTashkiled:count},
  money:{type:selected(enumFields.moneyType,"collection"),amountCents:{type:"integer",min:1,max:100000000},currency:selected(["CAD"],"CAD"),date:when,note:text(500),reference:text(120)},
  tashkil:{context:selected(["Jawla","Bayaan","General","Other"],"General"),intention:text(300),personName:text(100),note:text(1500),followUp:text(500),followUpOwnerId:ref,followUpDueDay:when,followUpStatus:selected(["open","done"],"open")},
  message:{text:text(2000)}, masjid_note:{jamaatId:ref,text:text(3000),localWork:text(2000)},
  incident:{severity:selected(enumFields.severity,"moderate"),description:text(5000),followUp:text(3000)},
  event:{type:selected(enumFields.eventType,"Ijtema"),locationId:ref,details:text(2000)},
  team:{personId:ref,details:text(1000)}, duty:{personId:ref,details:text(1000),dueAt:when},
};
const editFields: Record<string,string[]> = {
  jamaat:["route","summary"], stay:["hostStatus","conditions"], assignment:["details","date","personId"],
  note:["text","category","peopleTashkiled","jamaatsTashkiled"], money:["note"],
  tashkil:["context","intention","personName","note","followUp"], incident:["description","followUp","severity"],
  event:["details","locationId"], team:["details","personId"], duty:["details","personId","dueAt"],
  mashwara:["details","locationId"], umoor:["notes","decision","followUp"],
  place:["address","notes","hostPermission","type"], masjid_note:["text","localWork"],
  message:[], suggestion:[], opinion:[], collaborator:[], attendee:[],
};
const editExtra:Record<string,Record<string,FieldRule>> = {
  jamaat:{route:text(500),summary:text(1000)},
  mashwara:{details:text(2000),locationId:ref},
  umoor:{notes:text(2000),decision:text(3000),followUp:text(3000)},
  place:{hostPermission:selected(enumFields.hostPermission),type:selected(enumFields.placeType)},
};
const statuses:Record<string,string[]> = {
  jamaat:["planning","ready","out","returned","cancelled"], stay:["proposed","contacted","confirmed","arrived","completed","cancelled"],
  incident:["open","in-review","resolved"], event:["planned","active","completed","cancelled"],
  team:["planned","active","completed"], duty:["open","in-progress","done"], mashwara:["planned","active","completed","cancelled"],
  umoor:["open","done"],
};

function field(value:unknown,label:string,rule:FieldRule):unknown {
  if (rule.type === "text" || rule.type === "reference") return string(value,label,rule.max || 80);
  if (rule.type === "date") return date(value,label);
  if (rule.type === "integer") return integer(value,label,rule.min || 0,rule.max || 100000,rule.fallback as number|undefined);
  return choice(value,label,rule.choices || [],rule.fallback as string|undefined);
}

function fields(raw:unknown,rules:Record<string,FieldRule>,partial=false):Input {
  const supplied = object(raw,"Data");
  keys(supplied,Object.keys(rules));
  const result:Input = {};
  for (const [name,rule] of Object.entries(rules)) if (!partial || Object.hasOwn(supplied,name)) result[name] = field(supplied[name],name,partial?{...rule,fallback:undefined}:rule);
  return result;
}

export function createJamaatInput(body:Input) {
  keys(body,["action","title","startAt","endAt","kind","route","ameerId","selfAmeer"]);
  const title=string(body.title,"a Jamaat name",120,true), start=date(body.startAt,"a start date",true)!, end=date(body.endAt,"an end date",true)!;
  if (!isCivilDate(start) || !isCivilDate(end)) throw new InputError("Jamaat trip days must be calendar dates without times.");
  interval(start,end);
  return {title,start,end,kind:choice(body.kind,"Jamaat type",enumFields.jamaatKind,"regular"),route:string(body.route,"route",500),ameerId:string(body.ameerId,"Ameer",80),selfAmeer:boolean(body.selfAmeer,"selfAmeer")};
}

export function createItemInput(body:Input) {
  keys(body,["action","kind","parentId","title","startAt","endAt","data","requestId","idempotencyKey","allowPotentialDuplicate"]);
  const kind=choice(body.kind,"item type",Object.keys(createFields));
  if (body.requestId !== undefined && (!["duty","message"].includes(kind) || typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.requestId))) throw new InputError("Choose a valid request ID.");
  if (body.idempotencyKey !== undefined && kind !== "money") throw new InputError("This item does not accept a Baraka request ID.");
  if (body.allowPotentialDuplicate !== undefined && (kind!=="place" || typeof body.allowPotentialDuplicate!=="boolean")) throw new InputError("Invalid place duplicate review choice.");
  const title=string(body.title,"a title",200,true), parentId=string(body.parentId,"parent",80) || null;
  const start=date(body.startAt,"a start date"), end=date(body.endAt,"an end date");
  interval(start,end);
  if ((kind === "stay" || kind === "event") && (!start || !end)) throw new InputError("Choose valid start and end dates.");
  if ((kind === "stay" || kind === "event") && temporalKind(start) !== temporalKind(end)) throw new InputError("Start and end must use the same date format.");
  const values=fields(body.data,createFields[kind]);
  if (kind === "money" && !isCivilDate(values.date)) throw new InputError("Choose a valid local Baraka day.");
  if (kind === "tashkil" && values.followUpDueDay && !isCivilDate(values.followUpDueDay)) throw new InputError("Choose a local follow-up day.");
  if (kind === "assignment" && !values.date) throw new InputError("Choose a date.");
  return {kind,title,parentId,start,end,values};
}

export function recordedRevisionInput(body:Input,kind:string) {
  keys(body,["action","id","expectedUpdatedAt","title","status","reason","data"]);
  if (!["note","tashkil","masjid_note","incident"].includes(kind)) throw new InputError("This record cannot be revised here.");
  const title=string(body.title,"a title",200,true);
  const reason=string(body.reason,"a correction reason",500,true);
  if (reason.length<5) throw new InputError("Explain the correction in at least five characters.");
  const status=kind==="incident"?choice(body.status,"incident status",statuses.incident):"recorded";
  if (kind!=="incident" && body.status!==undefined) throw new InputError("This record does not have a status control.");
  const values=fields(body.data,createFields[kind]);
  if (kind==="tashkil" && values.followUpDueDay && !isCivilDate(values.followUpDueDay)) throw new InputError("Choose a local follow-up day.");
  return {title,reason,status,values};
}

export function createMashwaraInput(body:Input) {
  keys(body,["action","title","type","startAt","recurrence","ameerId","locationId","visibility","details","timeZone","seriesEndCount","seriesEndDay"]);
  const start=date(body.startAt,"a date and time",true)!;
  if (temporalKind(start)!=="instant") throw new InputError("Choose a Mashwara date and time with an offset.");
  const recurrence=choice(body.recurrence,"recurrence",enumFields.recurrence,"none");
  const timeZone=body.timeZone===undefined?"":string(body.timeZone,"timezone",100);
  if(timeZone&&!isIanaTimeZone(timeZone))throw new InputError("Choose a valid IANA timezone.");
  const seriesEndCount=body.seriesEndCount===undefined||body.seriesEndCount===null?null:integer(body.seriesEndCount,"series occurrence limit",1,520);
  const seriesEndDay=body.seriesEndDay===undefined||body.seriesEndDay===null||body.seriesEndDay===""?null:body.seriesEndDay;
  if(seriesEndDay!==null&&!isCivilDate(seriesEndDay))throw new InputError("Choose a valid series end day.");
  if(seriesEndCount!==null&&seriesEndDay!==null)throw new InputError("Choose one series end condition.");
  if(recurrence==="none"&&(seriesEndCount!==null||seriesEndDay!==null))throw new InputError("A one-time Mashwara does not need a series end.");
  return {title:string(body.title,"a Mashwara name",160,true),start,type:choice(body.type,"Mashwara type",enumFields.mashwaraType,"general"),recurrence,ameerId:string(body.ameerId,"Mashwara Ameer",80),locationId:string(body.locationId,"location",80),visibility:choice(body.visibility,"visibility",enumFields.visibility,"markaz"),details:string(body.details,"details",2000),timeZone,seriesEndCount,seriesEndDay};
}

export function updateItemInput(body:Input,kind:string,existing:Input) {
  keys(body,["action","id","expectedUpdatedAt","title","startAt","endAt","status","data"]);
  if (!Object.hasOwn(editFields,kind)) throw new InputError("This item type cannot be edited here.");
  const title=Object.hasOwn(body,"title")?string(body.title,"a title",200,true):String(existing.title);
  const start=Object.hasOwn(body,"startAt")?date(body.startAt,"a start date"):existing.start_at as string|null;
  const end=Object.hasOwn(body,"endAt")?date(body.endAt,"an end date"):existing.end_at as string|null;
  if (Object.hasOwn(body,"startAt") || Object.hasOwn(body,"endAt")) interval(start,end);
  if (["jamaat","stay","event"].includes(kind) && (!start || !end)) throw new InputError("Choose valid start and end dates.");
  if (kind === "mashwara" && !start) throw new InputError("Choose a valid Mashwara date.");
  if (Object.hasOwn(body,"startAt") || Object.hasOwn(body,"endAt")) {
    if (kind === "jamaat" && (!isCivilDate(start) || !isCivilDate(end))) throw new InputError("Jamaat trip days must be calendar dates without times.");
    if (["stay","event"].includes(kind) && temporalKind(start)!==temporalKind(end)) throw new InputError("Start and end must use the same date format.");
    let dailyMashwara=false;
    if (kind === "mashwara" && typeof existing.data === "string") {
      try { dailyMashwara=JSON.parse(existing.data)?.daily === true; } catch { /* Historical malformed data stays available for review. */ }
    }
    if (kind === "mashwara" && start && temporalKind(start)!==(dailyMashwara?"date":"instant")) throw new InputError("Choose a valid Mashwara date and time.");
  }
  let status=String(existing.status);
  if (Object.hasOwn(body,"status")) status=choice(body.status,"status",statuses[kind] || [status]);
  const rules={...createFields[kind],...editExtra[kind]};
  const allowed=Object.fromEntries(editFields[kind].map(name=>[name,rules[name]])) as Record<string,FieldRule>;
  const patch=fields(body.data === undefined ? {} : body.data,allowed,true);
  return {title,start,end,status,patch};
}
