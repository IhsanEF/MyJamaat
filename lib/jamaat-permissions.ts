import { approvedAmeer, draftCreator, verifiedGrant } from "./ameer-authority";
import { InputError } from "./api-validation";

export const jamaatScopes = ["roster", "route", "amaal", "contacts", "funds", "notes", "tashkil", "incidents"] as const;
export type JamaatScope = typeof jamaatScopes[number];
type Row = Record<string, unknown>;

const planningScopes: JamaatScope[] = ["roster", "route", "amaal"];

export function grantedScope(permissions: Row, scope: JamaatScope): boolean {
  const grant = permissions.grant;
  if (grant && typeof grant === "object" && !Array.isArray(grant)) {
    const meta = grant as Row;
    if (meta.version === 2 && typeof meta.by === "string" && meta.by && ["markaz-leader", "approved-ameer"].includes(String(meta.authority))) {
      return Array.isArray(permissions.scopes) && permissions.scopes.includes(scope);
    }
  }
  // Task 04 grants had trustworthy actor provenance but only two coarse fields.
  // Preserve their planning/contact intent without extending them to protected records.
  if (planningScopes.includes(scope)) return verifiedGrant(permissions, "manage");
  if (scope === "contacts") return verifiedGrant(permissions, "viewContacts");
  return false;
}

export function effectiveScopes(input: { leader: boolean; jamaat: Row; details: Row; personId: unknown; member: boolean; permissions: Row }): JamaatScope[] {
  const {leader,jamaat,details,personId,member,permissions} = input;
  if (leader || (member && approvedAmeer(details,personId))) return [...jamaatScopes];
  if (!member) return [];
  if (draftCreator(jamaat,details,personId)) return [...planningScopes];
  return jamaatScopes.filter(scope=>grantedScope(permissions,scope));
}

export function permissionFields(scopes: readonly JamaatScope[], labels: string[], actorId: string, authority: "markaz-leader" | "approved-ameer", at: string) {
  const selected = jamaatScopes.filter(scope=>scopes.includes(scope));
  return {
    scopes:selected,
    manage:planningScopes.every(scope=>selected.includes(scope)),
    viewContacts:selected.includes("contacts"),
    labels,
    grant:{version:2,by:actorId,authority,at},
  };
}

export function requestedScopes(body: Row): JamaatScope[] {
  const supplied = body.scopes;
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.some(scope=>typeof scope !== "string" || !jamaatScopes.includes(scope as JamaatScope))) throw new InputError("Choose valid permission scopes.");
    return jamaatScopes.filter(scope=>supplied.includes(scope));
  }
  const selected = planningScopes.filter(scope=>body[scope] === true);
  if (body.manage === true) selected.push(...planningScopes.filter(scope=>!selected.includes(scope)));
  for (const scope of jamaatScopes.slice(3)) if (body[scope] === true || (scope === "contacts" && body.viewContacts === true)) selected.push(scope);
  return selected;
}
