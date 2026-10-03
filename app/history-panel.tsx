"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { UiCopy, useUiLocale } from "@/app/ui-locale";
import { formatUiDateTime, uiText } from "@/lib/ui-localization";

type AuditEvent={id:string;actorName:string;actorId:string;action:string;objectId:string|null;subjectName:string|null;subjectId:string|null;summary:Record<string,unknown>;createdAt:string};
type RetentionRow={category:string;configuredDays:number|null;total:number;oldest:string|null;proposedCount:number|null;policyReference:string|null;action:string};

export function HistoryPanel({zone}:{zone:string}){
  const {locale,t}=useUiLocale();
  const [events,setEvents]=useState<AuditEvent[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [report,setReport]=useState<RetentionRow[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let live=true;
    Promise.all([fetch("/api/history?view=audit",{cache:"no-store"}),fetch("/api/history?view=retention",{cache:"no-store"})])
      .then(async([audit,retention])=>{
        if(!audit.ok||!retention.ok)throw new Error(uiText(locale,"history.loadFailed"));
        return Promise.all([audit.json() as Promise<{events:AuditEvent[];nextCursor:string|null}>,retention.json() as Promise<{report:RetentionRow[]}>]);
      }).then(([audit,retention])=>{if(live){setEvents(audit.events||[]);setNextCursor(audit.nextCursor||null);setReport(retention.report||[]);}})
      .catch(cause=>{if(live)setError(cause instanceof Error?cause.message:uiText(locale,"history.loadFailed"));});
    return ()=>{live=false;};
  },[locale]);
  const loadMore=async()=>{
    if(!nextCursor||busy)return;
    setBusy(true);setError("");
    try{
      const response=await fetch(`/api/history?view=audit&cursor=${encodeURIComponent(nextCursor)}`,{cache:"no-store"});
      if(!response.ok)throw new Error(t("history.loadFailed"));
      const result=await response.json() as {events:AuditEvent[];nextCursor:string|null};
      setEvents(current=>[...current,...result.events]);setNextCursor(result.nextCursor);
    }catch(cause){setError(cause instanceof Error?cause.message:t("history.loadFailed"));}
    finally{setBusy(false);}
  };
  return <>
    <section className="card"><h2><UiCopy id="history.auditTitle"/></h2><p><UiCopy id="history.auditHelp"/></p>{error&&<p role="alert" className="form-error">{error}</p>}
      {events.length?<div className="history-list">{events.map(event=><div className="record" key={event.id}><strong>{event.action}</strong><small>{formatUiDateTime(event.createdAt,locale,zone)} · {event.actorName}</small>{event.subjectId&&<p><UiCopy id="history.subject" after={" "}/>{event.subjectName||event.subjectId}</p>}{event.objectId&&<p><UiCopy id="history.record" after={" "}/>{event.objectId}</p>}{Object.entries(event.summary).map(([key,value])=><p key={key}>{key}: {Array.isArray(value)?value.join(", "):String(value)}</p>)}</div>)}</div>:<p className="empty"><UiCopy id="history.noEvents"/></p>}
      {nextCursor&&<Button variant="outline" disabled={busy} onClick={loadMore}><UiCopy id="action.loadMoreRecords"/></Button>}
    </section>
    <section className="card"><h2><UiCopy id="history.retentionTitle"/></h2><p><UiCopy id="history.retentionHelp"/></p>{report.length?<div className="history-list">{report.map(row=><div className="simple-row" key={row.category}><div><strong>{row.category}</strong><small>{row.total} <UiCopy id="history.records"/> · {row.configuredDays===null?t("history.policyPending"):`${row.configuredDays} ${t("history.days")}`}</small>{row.policyReference&&<p><UiCopy id="history.policyReference" after={" "}/>{row.policyReference}</p>}{row.proposedCount!==null&&<p>{row.proposedCount} <UiCopy id="history.proposedReview"/></p>}</div></div>)}</div>:<p className="empty"><UiCopy id="history.policyPending"/></p>}</section>
  </>;
}
