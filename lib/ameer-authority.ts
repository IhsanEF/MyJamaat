type RecordData = Record<string, unknown>;

export function approvedAmeer(details: RecordData, personId: unknown) {
  return details.ameerStatus === "approved" && details.ameerId === personId;
}

export function draftCreator(jamaat: RecordData, details: RecordData, personId: unknown) {
  return jamaat.created_by === personId && details.ameerStatus !== "approved";
}

export function verifiedGrant(permissions: RecordData, scope: "manage" | "viewContacts") {
  const grant = permissions.grant;
  return permissions[scope] === true && grant !== null && typeof grant === "object" && !Array.isArray(grant)
    && typeof (grant as RecordData).by === "string" && (grant as RecordData).by !== ""
    && ["markaz-leader", "approved-ameer"].includes(String((grant as RecordData).authority));
}

export function needsLegacyGrantReview(permissions: RecordData) {
  return permissions.review === "legacy-grant-needs-review"
    || (permissions.manage === true && !verifiedGrant(permissions, "manage"))
    || (permissions.viewContacts === true && !verifiedGrant(permissions, "viewContacts"));
}

export function revokeUnverifiedGrant(permissions: RecordData) {
  if (!needsLegacyGrantReview(permissions)) return permissions;
  return { ...permissions, manage:verifiedGrant(permissions,"manage"), viewContacts:verifiedGrant(permissions,"viewContacts"), review:"legacy-unverified-grant-revoked" };
}
