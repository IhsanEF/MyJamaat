export const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

export function newInvitationToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2,"0")).join("").toUpperCase();
}

export function normalizeInvitationToken(value: unknown) {
  if (typeof value !== "string") return "";
  const token = value.trim().replaceAll("-","").toUpperCase();
  return /^[0-9A-F]{32}$/.test(token) ? token : "";
}

export async function invitationHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
}

const personKeys = new Set(["personId","ameerId","authorId","reportedBy","pendingAmeerId","formerDailyAmeerId","removedAssigneeId","ownerId","followUpOwnerId","completedBy","reviewedBy","decisionBy","progressBy","archivedBy","restoredBy"]);
const personArrayKeys = new Set(["personIds","removedPersonIds"]);

export function replacePersonReferences(value: unknown, sourceId: string, targetId: string): unknown {
  if (Array.isArray(value)) return value.map(item=>replacePersonReferences(item,sourceId,targetId));
  if (!value || typeof value !== "object") return value;
  const updated:Record<string,unknown> = {};
  for (const [key,item] of Object.entries(value)) {
    if (personKeys.has(key) && item === sourceId) updated[key] = targetId;
    else if (personArrayKeys.has(key) && Array.isArray(item)) updated[key] = [...new Set(item.map(entry=>entry===sourceId?targetId:entry))];
    else updated[key] = replacePersonReferences(item,sourceId,targetId);
  }
  return updated;
}
