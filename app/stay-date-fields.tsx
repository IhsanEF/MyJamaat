"use client";

import { useState, type SyntheticEvent } from "react";
import { Input } from "@/components/ui/input";
import { UiCopy, useUiLocale } from "@/app/ui-locale";
import { addCivilDays, civilDayDistance, isCivilDate } from "@/lib/schedule-time";

// The saved route still uses dates; the duration is a convenient way to enter them.
export function StayDateFields({initialDay,tripStart,tripEnd,timed,setTimed}:{initialDay:string;tripStart:string;tripEnd:string;timed:boolean;setTimed:(value:boolean)=>void}) {
  const {t}=useUiLocale();
  const [start,setStart]=useState(initialDay);
  const [end,setEnd]=useState(initialDay);
  const [days,setDays]=useState("1");
  const endFor=(day:string,count:string)=>isCivilDate(day)&&/^\d+$/.test(count)&&Number(count)>0&&Number(count)<=36600?addCivilDays(day,Number(count)-1):"";
  const changeStart=(event:SyntheticEvent<HTMLInputElement>)=>{const value=event.currentTarget.value;setStart(value);if(!timed)setEnd(endFor(value,days));};
  const changeEnd=(event:SyntheticEvent<HTMLInputElement>)=>{const value=event.currentTarget.value;setEnd(value);if(!timed)setDays(isCivilDate(start)&&isCivilDate(value)&&value>=start?String(civilDayDistance(start,value)+1):"");};
  return <>
    <label className="check-line"><input type="checkbox" checked={timed} onChange={event=>{
      const next=event.target.checked;
      const first=start.slice(0,10),last=end.slice(0,10);
      setStart(next?`${first}T12:00`:first);
      setEnd(next?`${last}T13:00`:last);
      if(!next)setDays(isCivilDate(first)&&isCivilDate(last)&&last>=first?String(civilDayDistance(first,last)+1):"");
      setTimed(next);
    }}/><UiCopy id="inline.includeArrivalAndDepartureTimes" before=" "/></label>
    <div className="two-fields">
      <label className="field"><span>{t("field.from")}</span><Input name="startAt" type={timed?"datetime-local":"date"} min={timed?undefined:tripStart} max={timed?undefined:tripEnd} required value={start} onInput={changeStart} onChange={changeStart}/></label>
      {!timed&&<label className="field"><span>{t("route.numberOfDays")}</span><Input type="number" min="1" step="1" max={isCivilDate(start)&&isCivilDate(tripEnd)?Math.max(1,civilDayDistance(start,tripEnd)+1):undefined} required value={days} onChange={event=>{setDays(event.target.value);setEnd(endFor(start,event.target.value));}}/></label>}
      <label className="field"><span>{t("field.to")}</span><Input name="endAt" type={timed?"datetime-local":"date"} min={timed?undefined:start||tripStart} max={timed?undefined:tripEnd} required value={end} onInput={changeEnd} onChange={changeEnd}/></label>
    </div>
    {!timed&&<p className="form-hint"><UiCopy id="route.inclusiveDates"/></p>}
  </>;
}
