import { env } from "cloudflare:workers";

type Database=NonNullable<typeof env.DB>;
export type QuotaGroup="write"|"join"|"claim"|"invite"|"directory"|"history"|"export";
export type QuotaScope="user"|"tenant";
const quotas:Record<QuotaGroup,Record<QuotaScope,{max:number;windowMs:number}>>={
  write:{user:{max:120,windowMs:60_000},tenant:{max:600,windowMs:60_000}},
  join:{user:{max:5,windowMs:15*60_000},tenant:{max:60,windowMs:15*60_000}},
  claim:{user:{max:10,windowMs:15*60_000},tenant:{max:30,windowMs:15*60_000}},
  invite:{user:{max:20,windowMs:60*60_000},tenant:{max:80,windowMs:60*60_000}},
  directory:{user:{max:6,windowMs:15*60_000},tenant:{max:60,windowMs:15*60_000}},
  history:{user:{max:60,windowMs:15*60_000},tenant:{max:300,windowMs:15*60_000}},
  export:{user:{max:5,windowMs:60*60_000},tenant:{max:100,windowMs:60*60_000}},
};

export type QuotaDecision={allowed:true}|{allowed:false;retryAfterSeconds:number};

async function keyFor(group:QuotaGroup,scope:QuotaScope,subject:string):Promise<string>{
  const bytes=new TextEncoder().encode(`${scope}:${subject}`);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return `${group}:${scope}:`+Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
}

export async function takeQuota(db:Database,group:QuotaGroup,scope:QuotaScope,subject:string,clock=Date.now()):Promise<QuotaDecision>{
  const {max,windowMs}=quotas[group][scope],windowStart=Math.floor(clock/windowMs)*windowMs;
  const key=await keyFor(group,scope,subject);
  const row=await db.prepare(`INSERT INTO abuse_counters (key,window_start,hits) VALUES (?,?,1)
    ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,
      hits=CASE WHEN abuse_counters.window_start=excluded.window_start THEN MIN(abuse_counters.hits+1,?) ELSE 1 END
    RETURNING hits`).bind(key,windowStart,max+1).first<{hits:number}>();
  if(Number(row?.hits||0)<=max)return {allowed:true};
  return {allowed:false,retryAfterSeconds:Math.max(1,Math.ceil((windowStart+windowMs-clock)/1000))};
}
