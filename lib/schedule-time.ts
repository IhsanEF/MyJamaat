export const DEFAULT_TIME_ZONE = "America/Vancouver";

const civilPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const instantPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const localPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const formatterCache = new Map<string,Intl.DateTimeFormat>();
// Some Worker runtimes still ship pre-2026b Vancouver rules. B.C. and IANA 2026b
// keep Pacific time fixed after 2026-03-08. Phoenix has the same IANA rule for
// this forward period, so use it only while resolving Vancouver instants there.
// Persisted zone names remain America/Vancouver. Remove this compatibility
// mapping once every supported runtime carries the updated zone database.
function effectiveZone(value:Date,zone:string):string {
  return zone==="America/Vancouver"&&value.getTime()>=Date.parse("2026-03-09T00:00:00Z")?"America/Phoenix":zone;
}

export function isCivilDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = civilPattern.exec(value);
  if (!match) return false;
  const [year,month,day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year,month-1,day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month-1 && parsed.getUTCDate() === day;
}

export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100 || !value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US",{timeZone:value}); return true; } catch { return false; }
}

export function scheduleZone(value: unknown): string {
  return isIanaTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

export function parseOffsetInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = instantPattern.exec(value);
  if (!match || !isCivilDate(match[1])) return null;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return null;
  if (match[6] !== "Z" && (Number(match[8]) > 14 || Number(match[9]) > 59 || Number(match[8]) === 14 && Number(match[9]) !== 0)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function temporalKind(value: unknown): "date" | "instant" | "invalid" {
  if (isCivilDate(value)) return "date";
  if (parseOffsetInstant(value)) return "instant";
  return "invalid";
}

export function intervalValid(start: string, end: string): boolean {
  const kind = temporalKind(start);
  if (kind === "invalid" || temporalKind(end) !== kind) return false;
  return kind === "date" ? end >= start : Date.parse(end) > Date.parse(start);
}

export function addCivilDays(day: string, count: number): string {
  if (!isCivilDate(day) || !Number.isInteger(count)) throw new Error("Choose a valid calendar day.");
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate()+count);
  return date.toISOString().slice(0,10);
}

export function civilDayDistance(start: string, end: string): number {
  if (!isCivilDate(start) || !isCivilDate(end)) throw new Error("Choose valid calendar days.");
  return Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000);
}

export function weekStartDay(day: string): string {
  if (!isCivilDate(day)) throw new Error("Choose a valid calendar day.");
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addCivilDays(day,-((weekday+6)%7));
}

function formatter(zone: string,value:Date): Intl.DateTimeFormat {
  const selected = effectiveZone(value,scheduleZone(zone));
  let result = formatterCache.get(selected);
  if (!result) {
    result = new Intl.DateTimeFormat("en-CA",{timeZone:selected,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
    formatterCache.set(selected,result);
  }
  return result;
}

function parts(value: Date, zone: string) {
  const fields = Object.fromEntries(formatter(zone,value).formatToParts(value).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  return {year:Number(fields.year),month:Number(fields.month),day:Number(fields.day),hour:Number(fields.hour),minute:Number(fields.minute),second:Number(fields.second)};
}

export function localDay(value: string | Date | null | undefined, zone: string): string | null {
  if (!value) return null;
  if (typeof value === "string" && isCivilDate(value)) return value;
  const date = value instanceof Date ? value : new Date(parseOffsetInstant(value) || "invalid");
  if (Number.isNaN(date.getTime())) return null;
  const p=parts(date,zone);
  return `${String(p.year).padStart(4,"0")}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
}

export function localDateTimeInput(value: string | null | undefined, zone: string): string {
  if (!value) return "";
  if (isCivilDate(value)) return `${value}T20:00`;
  const instant=parseOffsetInstant(value);
  if (!instant) return "";
  const p=parts(new Date(instant),zone);
  return `${String(p.year).padStart(4,"0")}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}T${String(p.hour).padStart(2,"0")}:${String(p.minute).padStart(2,"0")}`;
}

function offsetMinutes(value: Date, zone: string): number {
  const p=parts(value,zone);
  return Math.round((Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-value.getTime())/60000);
}

export function localDateTimeToInstant(value: string, zone: string): string {
  const match=localPattern.exec(value);
  if (!match || !isCivilDate(match[1]) || Number(match[2])>23 || Number(match[3])>59 || !isIanaTimeZone(zone)) throw new Error("Choose a valid local date, time and timezone.");
  const target=Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  const candidates=new Set<string>();
  for (const delta of [-36,-12,0,12,36]) {
    const offset=offsetMinutes(new Date(target+delta*3600000),zone);
    const candidate=new Date(target-offset*60000);
    if (localDateTimeInput(candidate.toISOString(),zone)===value) candidates.add(candidate.toISOString());
  }
  if (candidates.size===0) throw new Error("This local time does not exist because the clock changes. Choose another time.");
  if (candidates.size>1) throw new Error("This local time occurs twice because the clock changes. Choose another time.");
  return [...candidates][0];
}

export function displayScheduleDate(value: string | null | undefined, zone: string, includeTime=false, locale="en-CA"): string {
  const displayLocale=locale==="ar-XB"?"ar-EG":"en-CA";
  if (!value) return "Date not set";
  if (isCivilDate(value)) return new Intl.DateTimeFormat(displayLocale,{timeZone:"UTC",month:"short",day:"numeric",year:"numeric"}).format(new Date(`${value}T12:00:00Z`));
  const instant=parseOffsetInstant(value);
  if (!instant) return "Date needs review";
  return new Intl.DateTimeFormat(displayLocale,{timeZone:effectiveZone(new Date(instant),scheduleZone(zone)),month:"short",day:"numeric",year:"numeric",...(includeTime?{hour:"numeric",minute:"2-digit"}:{} )}).format(new Date(instant));
}

export function shiftedTemporalRange(start: string, end: string | null, day: string, zone: string) {
  if (!isCivilDate(day)) throw new Error("Choose a valid destination day.");
  if (isCivilDate(start)) return {startAt:day,endAt:end&&isCivilDate(end)?addCivilDays(day,civilDayDistance(start,end)):null};
  const original=parseOffsetInstant(start);
  if (!original) throw new Error("This record has an invalid date and needs review before moving.");
  const local=localDateTimeInput(original,zone);
  const moved=localDateTimeToInstant(`${day}${local.slice(10)}`,zone);
  const originalEnd=end?parseOffsetInstant(end):null;
  return {startAt:moved,endAt:originalEnd?new Date(Date.parse(moved)+Date.parse(originalEnd)-Date.parse(original)).toISOString():null};
}
