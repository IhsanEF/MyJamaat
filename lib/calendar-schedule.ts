import { addCivilDays, intervalValid, isCivilDate, localDay, parseOffsetInstant, shiftedTemporalRange } from "./schedule-time.ts";

export function calendarSpan(start:string|null,end:string|null,zone:string):[string,string]|null {
  if (!start) return null;
  const first=localDay(start,zone);
  if (!first) return null;
  if (!end) return [first,first];
  if (!intervalValid(start,end)) return null;
  if (isCivilDate(start) && isCivilDate(end)) return [start,end];
  const instant=parseOffsetInstant(end);
  if (!instant) return null;
  return [first,localDay(new Date(Date.parse(instant)-1),zone)!];
}

export function calendarOccupies(start:string|null,end:string|null,day:string,zone:string):boolean {
  const span=calendarSpan(start,end,zone);
  return !!span && span[0]<=day && day<=span[1];
}

export function calendarMovePreview(start:string,end:string|null,destination:string,zone:string) {
  const moved=shiftedTemporalRange(start,end,destination,zone);
  return {startAt:moved.startAt,endAt:moved.endAt,firstDay:destination,lastDay:calendarSpan(moved.startAt,moved.endAt,zone)?.[1]||destination};
}

export function calendarWeekDays(first:string):string[] {
  return Array.from({length:7},(_,index)=>addCivilDays(first,index));
}
