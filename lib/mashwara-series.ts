import { addCivilDays, isCivilDate, localDateTimeInput, localDateTimeToInstant, parseOffsetInstant, scheduleZone } from "./schedule-time.ts";

export type RecurrenceFrequency="weekly"|"monthly";
export type RecurrenceRule={anchorInstant:string;timeZone:string;frequency:RecurrenceFrequency;endCount:number|null;endDay:string|null;monthlyAnchorDay?:number};

function monthlyDay(anchorDay:string,index:number,monthlyAnchorDay?:number):string {
  const [year,month,originalDay]=anchorDay.split("-").map(Number);
  const day=monthlyAnchorDay??originalDay;
  if(!Number.isInteger(day)||day<1||day>31)throw new Error("Choose a valid monthly anchor day.");
  const first=new Date(Date.UTC(year,month-1+index,1));
  const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth()+1).padStart(2,"0")}-${String(Math.min(day,last)).padStart(2,"0")}`;
}

export function seriesOccurrence(rule:RecurrenceRule,index:number):{day:string;local:string;instant:string}|null {
  if(!Number.isInteger(index)||index<0||index>5200)throw new Error("Occurrence number is outside the supported range.");
  if(rule.endCount!==null&&index>=rule.endCount)return null;
  const anchor=parseOffsetInstant(rule.anchorInstant);
  if(!anchor)throw new Error("Choose a valid series start time.");
  const zone=scheduleZone(rule.timeZone);
  const localAnchor=localDateTimeInput(anchor,zone);
  const firstDay=localAnchor.slice(0,10);
  const day=rule.frequency==="weekly"?addCivilDays(firstDay,index*7):monthlyDay(firstDay,index,rule.monthlyAnchorDay);
  if(rule.endDay!==null&&day>rule.endDay)return null;
  const local=`${day}${localAnchor.slice(10)}`;
  let instant:string;
  try{instant=localDateTimeToInstant(local,zone);}
  catch(cause){
    if(cause instanceof Error&&cause.message.includes("occurs twice")){
      // Use the earlier instant when the fall clock repeats this local minute.
      const naive=Date.parse(`${local}:00Z`),matches:string[]=[];
      for(let offset=-14*60;offset<=14*60;offset+=15){
        const candidate=new Date(naive-offset*60000).toISOString();
        if(localDateTimeInput(candidate,zone)===local)matches.push(candidate);
      }
      if(!matches.length)throw cause;
      instant=matches.sort()[0];
      return {day,local,instant};
    }
    // A spring clock gap shifts this single occurrence forward to its first valid minute.
    if(!(cause instanceof Error)||!cause.message.includes("does not exist"))throw cause;
    const date=new Date(`${day}T${localAnchor.slice(11)}:00Z`);
    let found:string|null=null;
    for(let minute=1;minute<=180;minute++){
      date.setUTCMinutes(date.getUTCMinutes()+1);
      const candidate=date.toISOString().slice(0,16);
      try{found=localDateTimeToInstant(candidate,zone);break;}catch{/* Continue through the clock gap. */}
    }
    if(!found)throw new Error("This recurring local time cannot be resolved.");
    instant=found;
  }
  return {day,local:localDateTimeInput(instant,zone),instant};
}

export function previewSeries(rule:RecurrenceRule,fromIndex=0,limit=5){
  if(!Number.isInteger(limit)||limit<1||limit>24)throw new Error("Choose between 1 and 24 preview dates.");
  if(rule.endDay!==null&&!isCivilDate(rule.endDay))throw new Error("Choose a valid series end day.");
  const result:NonNullable<ReturnType<typeof seriesOccurrence>>[]=[];
  for(let index=fromIndex;result.length<limit&&index<fromIndex+limit;index++){
    const row=seriesOccurrence(rule,index);
    if(!row)break;
    result.push(row);
  }
  return result;
}
