export type WorkItem={id:string;kind:string;parentId:string|null;title:string;status:string;startAt:string|null;data:Record<string,unknown>;createdBy?:string};
export type PersonalDuty={id:string;title:string;detail:string;targetId:string;kind:string};

export function personalDuties(items:WorkItem[],personId:string):PersonalDuty[] {
  const byId=new Map(items.map(item=>[item.id,item]));
  const out:PersonalDuty[]=[];
  for(const item of items){
    if(item.kind==="assignment"&&item.data.personId===personId&&item.status!=="historical"){
      const jamaat=byId.get(String(item.parentId));if(jamaat)out.push({id:item.id,title:String(item.data.amal||item.title),detail:`${jamaat.title} · ${String(item.data.date||"Day to confirm")}`,targetId:jamaat.id,kind:"assignment"});
    }
    if(item.kind==="umoor"&&item.data.active===true&&Array.isArray(item.data.personIds)&&item.data.personIds.includes(personId)&&item.status!=="done"){
      const meeting=byId.get(String(item.parentId));if(meeting)out.push({id:item.id,title:item.title,detail:`A‘maal in ${meeting.title}`,targetId:meeting.id,kind:"umoor"});
    }
    if(item.kind==="duty"&&item.data.personId===personId&&item.status!=="done"){
      const team=byId.get(String(item.parentId)),event=byId.get(String(team?.parentId));if(event)out.push({id:item.id,title:item.title,detail:`${team?.title||"Team"} · ${event.title}`,targetId:event.id,kind:"duty"});
    }
    if(item.kind==="followup"&&item.data.ownerId===personId&&item.status!=="done"){
      const umoor=byId.get(String(item.parentId)),meeting=byId.get(String(umoor?.parentId));if(meeting)out.push({id:item.id,title:item.title,detail:`Follow-up in ${meeting.title}`,targetId:meeting.id,kind:"followup"});
    }
    if(item.kind==="tashkil"&&item.data.followUpOwnerId===personId&&item.data.followUpStatus!=="done")out.push({id:item.id,title:item.title,detail:"Tashkil follow-up",targetId:item.id,kind:"tashkil"});
  }
  return out;
}

export function contextualRole(role:string,items:WorkItem[],personId:string,scopes:string[]):string {
  if(role==="admin")return "Markaz admin";
  if(role==="markaz_ameer")return "Markaz Ameer";
  const labels:string[]=[];
  if(items.some(item=>item.kind==="jamaat"&&item.data.ameerStatus==="approved"&&item.data.ameerId===personId))labels.push("Jamaat Ameer");
  if(items.some(item=>item.kind==="jamaat"&&item.createdBy===personId&&item.data.ameerStatus==="pending"))labels.push("Jamaat organizer · approval pending");
  if(items.some(item=>item.kind==="mashwara"&&item.data.ameerId===personId))labels.push("Mashwara Ameer");
  if(items.some(item=>item.kind==="collaborator"&&item.status!=="removed"&&item.data.personId===personId))labels.push("Mashwara planner");
  if(items.some(item=>item.kind==="team"&&item.data.personId===personId))labels.push("Ijtema team Ameer");
  if(scopes.some(scope=>["roster","route","amaal"].includes(scope))&&!labels.some(label=>label.startsWith("Jamaat ")))labels.push("Jamaat planner");
  return labels.slice(0,2).join(" · ")||(items.some(item=>item.kind==="jamaat")?"Jamaat member":"Markaz member");
}
