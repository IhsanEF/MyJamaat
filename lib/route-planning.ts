import { addCivilDays, civilDayDistance, intervalValid, isCivilDate, localDay, parseOffsetInstant, scheduleZone, shiftedTemporalRange, temporalKind } from "./schedule-time.ts";

export type RouteRow = {
  id: string; kind: string; parentId: string | null; title:string; startAt: string | null; endAt: string | null;
  status: string; data: Record<string,unknown>; updatedAt: string;
};

export function occupiedDays(start: string, end: string, zone: string): [string,string] {
  if (temporalKind(start) !== temporalKind(end) || !intervalValid(start,end)) throw new Error("Choose a valid stay range.");
  if (isCivilDate(start) && isCivilDate(end)) return [start,end];
  const final = parseOffsetInstant(end);
  if (!final) throw new Error("Choose a valid departure time.");
  return [localDay(start,zone)!,localDay(new Date(Date.parse(final)-1),zone)!];
}

export function stayFitsTrip(start: string, end: string, tripStart: string, tripEnd: string, zone: string): boolean {
  if (!isCivilDate(tripStart) || !isCivilDate(tripEnd)) return false;
  const [first,last]=occupiedDays(start,end,zone);
  return first>=tripStart && last<=tripEnd;
}

export function stayRangesOverlap(a:{startAt:string;endAt:string}, b:{startAt:string;endAt:string}, zone:string): boolean {
  if (temporalKind(a.startAt)==="instant" && temporalKind(b.startAt)==="instant") {
    return Date.parse(a.startAt)<Date.parse(b.endAt) && Date.parse(b.startAt)<Date.parse(a.endAt);
  }
  const [aStart,aEnd]=occupiedDays(a.startAt,a.endAt,zone);
  const [bStart,bEnd]=occupiedDays(b.startAt,b.endAt,zone);
  return aStart<=bEnd && bStart<=aEnd;
}

export function shiftTripStay(start:string,end:string,dayDelta:number,zone:string):{startAt:string;endAt:string} {
  if (!Number.isInteger(dayDelta) || Math.abs(dayDelta)>3660) throw new Error("This date move is too large.");
  const first=localDay(start,zone);
  if (!first) throw new Error("This stay has an invalid historical date.");
  const moved=shiftedTemporalRange(start,end,addCivilDays(first,dayDelta),zone);
  if (!moved.endAt) throw new Error("This stay needs an end date.");
  return {startAt:moved.startAt,endAt:moved.endAt};
}

export function moveCivilDay(day:string,oldStart:string,newStart:string):string {
  if (!isCivilDate(day)) throw new Error("This linked plan has an invalid historical day.");
  return addCivilDays(day,civilDayDistance(oldStart,newStart));
}

export function venueForDay(day:string, stays:Array<{startAt:string;endAt:string;placeId:string;status:string}>, zone:string):string|null {
  const active=stays.filter(stay=>{if(stay.status==="cancelled")return false;try{const [start,end]=occupiedDays(stay.startAt,stay.endAt,zone);return start<=day&&day<=end;}catch{return false;}});
  if (active.length!==1) return null;
  return active[0].placeId||null;
}

export function routeZone(jamaat:RouteRow, fallback:string):string {
  return scheduleZone(jamaat.data.timeZone||fallback);
}

export type RouteChange = {id:string;title:string;startAt:string|null;endAt:string|null;status:string;data:Record<string,unknown>};
export type RouteChoice = {
  startAt:string; endAt:string; stayMode?:"shift"|"keep"; planMode?:"shift"|"keep";
  reconfirm?:boolean; retainHistory?:boolean; preserveDuration?:boolean; placeId?:string; hostStatus?:string; conditions?:string; route?:string; title?:string; status?:string;
};

export function planRouteChange(target:RouteRow,jamaat:RouteRow,children:RouteRow[],choice:RouteChoice,fallbackZone:string):RouteChange[] {
  if (jamaat.kind!=="jamaat" || !isCivilDate(jamaat.startAt) || !isCivilDate(jamaat.endAt)) throw new Error("This Jamaat has historical dates needing review.");
  if (target.kind!=="jamaat" && target.kind!=="stay") throw new Error("Choose a Jamaat or stay.");
  const zone=routeZone(jamaat,fallbackZone);
  const rows=[jamaat,...children];
  const planned=new Map(rows.map(row=>[row.id,{id:row.id,title:row.title,startAt:row.startAt,endAt:row.endAt,status:row.status,data:{...row.data}}]));
  const next=planned.get(target.id)!;
  if (!next) throw new Error("Route item not found.");
  let chosenEnd=choice.endAt;
  if(target.kind==="stay"&&choice.preserveDuration===true&&target.startAt&&target.endAt&&temporalKind(choice.startAt)===temporalKind(target.startAt)){
    chosenEnd=isCivilDate(choice.startAt)&&isCivilDate(target.startAt)&&isCivilDate(target.endAt)?addCivilDays(choice.startAt,civilDayDistance(target.startAt,target.endAt)):new Date(Date.parse(choice.startAt)+Date.parse(target.endAt)-Date.parse(target.startAt)).toISOString();
  }
  if (!intervalValid(choice.startAt,chosenEnd)) throw new Error("Choose an ordered date range.");
  if (target.kind==="jamaat" && (!isCivilDate(choice.startAt)||!isCivilDate(choice.endAt))) throw new Error("Jamaat dates must be calendar days.");
  if (target.kind==="stay" && temporalKind(choice.startAt)!==temporalKind(chosenEnd)) throw new Error("Stay arrival and departure must use the same date format.");
  const sameTime=(original:string|null,nextValue:string)=>original!==null&&temporalKind(original)===temporalKind(nextValue)&&(temporalKind(original)==="date"?original===nextValue:Date.parse(original)===Date.parse(nextValue));
  const moving=!sameTime(target.startAt,choice.startAt)||!sameTime(target.endAt,chosenEnd);
  if (moving && choice.planMode!=="shift" && choice.planMode!=="keep") throw new Error("Choose what happens to linked daily plans.");
  if (target.kind==="jamaat" && moving && choice.stayMode!=="shift" && choice.stayMode!=="keep") throw new Error("Choose what happens to linked stays.");
  if (target.kind==="jamaat" && moving && choice.retainHistory!==true) throw new Error("Acknowledge that dated financial and historical records keep their original dates.");
  next.startAt=sameTime(target.startAt,choice.startAt)?target.startAt:choice.startAt;
  next.endAt=sameTime(target.endAt,chosenEnd)?target.endAt:chosenEnd;
  if(choice.title!==undefined)next.title=choice.title;
  if(choice.status!==undefined)next.status=choice.status;
  const tripStart=target.kind==="jamaat"?choice.startAt:jamaat.startAt;
  const tripEnd=target.kind==="jamaat"?choice.endAt:jamaat.endAt;
  const oldDay=target.kind==="jamaat"?jamaat.startAt:localDay(target.startAt,zone);
  const newDay=target.kind==="jamaat"?choice.startAt:localDay(choice.startAt,zone);
  if (!oldDay||!newDay) throw new Error("This route has a historical date needing review.");
  const delta=civilDayDistance(oldDay,newDay);
  if (target.kind==="jamaat") {
    if (choice.route!==undefined) next.data.route=choice.route;
    if (moving && choice.stayMode==="shift") for (const stay of children.filter(row=>row.kind==="stay")) {
      if (!stay.startAt||!stay.endAt) throw new Error("A linked stay has dates needing review.");
      const shifted=shiftTripStay(stay.startAt,stay.endAt,delta,zone);
      const entry=planned.get(stay.id)!; entry.startAt=shifted.startAt;entry.endAt=shifted.endAt;
    }
  } else {
    if (choice.placeId!==undefined) next.data.placeId=choice.placeId;
    if (choice.hostStatus!==undefined) next.data.hostStatus=choice.hostStatus;
    if (choice.conditions!==undefined) next.data.conditions=choice.conditions;
  }
  const originalStays=children.filter(row=>row.kind==="stay"&&row.startAt&&row.endAt);
  const affectedDays=new Set<string>();
  if (target.kind==="stay" && moving && target.startAt && target.endAt) {
    const [first,last]=occupiedDays(target.startAt,target.endAt,zone);
    for(let day=first;day<=last;day=addCivilDays(day,1)) affectedDays.add(day);
    if(choice.planMode==="shift")for(const other of children.filter(row=>row.kind==="stay"&&row.id!==target.id&&row.status!=="cancelled"&&row.startAt&&row.endAt)){
      const [otherFirst,otherLast]=occupiedDays(other.startAt!,other.endAt!,zone);
      if([...affectedDays].some(day=>otherFirst<=day&&day<=otherLast))throw new Error("Daily plans share a day with another stay. Keep their dates and review the venue separately.");
    }
  }
  if (moving && choice.planMode==="shift") for (const row of children) {
    if (row.kind==="mashwara" && row.data.daily===true && row.startAt && (target.kind==="jamaat"||affectedDays.has(String(row.data.date||row.startAt)))) {
      const entry=planned.get(row.id)!;
      const day=moveCivilDay(String(row.data.date||row.startAt),oldDay,newDay);
      entry.startAt=day;entry.data.date=day;
    }
    if (row.kind==="assignment" && typeof row.data.date==="string" && (target.kind==="jamaat"||affectedDays.has(row.data.date))) {
      planned.get(row.id)!.data.date=moveCivilDay(row.data.date,oldDay,newDay);
    }
  }
  const stays=originalStays.map(row=>{const entry=planned.get(row.id)!;return {id:row.id,startAt:entry.startAt!,endAt:entry.endAt!,placeId:String(entry.data.placeId||""),status:entry.status,hostStatus:String(entry.data.hostStatus||"proposed")};});
  for(const stay of stays) if(!stayFitsTrip(stay.startAt,stay.endAt,tripStart,tripEnd,zone)) throw new Error(`Stay ${stay.id} falls outside the changed Jamaat dates.`);
  for(let i=0;i<stays.length;i++) for(let j=i+1;j<stays.length;j++) {
    if(stays[i].hostStatus==="confirmed"&&stays[j].hostStatus==="confirmed"&&stays[i].status!=="cancelled"&&stays[j].status!=="cancelled"&&stayRangesOverlap(stays[i],stays[j],zone)) throw new Error("Confirmed stays overlap. Resolve the route before saving.");
  }
  for(const row of originalStays) {
    const entry=planned.get(row.id)!;
    const moved=row.startAt!==entry.startAt||row.endAt!==entry.endAt||row.data.placeId!==entry.data.placeId;
    if(moved && ["confirmed","arrived","completed"].includes(String(row.data.hostStatus))) {
      if(!choice.reconfirm) throw new Error("A confirmed host must be marked for reconfirmation after this change.");
      entry.data.hostStatus="contacted";
    }
  }
  for(const row of children) {
    const entry=planned.get(row.id)!;
    if (row.kind==="mashwara"&&row.data.daily===true) {
      const day=String(entry.data.date||entry.startAt||"");
      if(!isCivilDate(day)||day<tripStart||day>tripEnd) throw new Error("A daily Mashwara falls outside the changed Jamaat dates.");
      entry.data.locationId=venueForDay(day,stays,zone);
    }
    if(row.kind==="assignment") {
      const day=String(entry.data.date||"");
      if(!isCivilDate(day)||day<tripStart||day>tripEnd) throw new Error("A daily assignment falls outside the changed Jamaat dates.");
    }
  }
  const dailyDays=children.filter(row=>row.kind==="mashwara"&&row.data.daily===true).map(row=>String(planned.get(row.id)!.data.date));
  if(new Set(dailyDays).size!==dailyDays.length) throw new Error("Two daily Mashwaras would land on the same day.");
  return rows.filter(row=>{const entry=planned.get(row.id)!;return row.title!==entry.title||row.startAt!==entry.startAt||row.endAt!==entry.endAt||row.status!==entry.status||JSON.stringify(row.data)!==JSON.stringify(entry.data);}).map(row=>planned.get(row.id)!);
}
