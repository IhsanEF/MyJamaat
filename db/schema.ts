import { sqliteTable, text, integer, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const markaz = sqliteTable("markaz", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  joinCode: text("join_code").notNull(),
  timeZone: text("time_zone").notNull().default("America/Vancouver"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("idx_markaz_join_code").on(t.joinCode)]);

export const abuseCounters = sqliteTable("abuse_counters", {
  key:text("key").primaryKey(),
  windowStart:integer("window_start").notNull(),
  hits:integer("hits").notNull(),
});

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  authId: text("auth_id"),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  role: text("role").notNull().default("worker"),
  claimedRole: text("claimed_role").notNull().default("worker"),
  localMasjidId: text("local_masjid_id"),
  localMarkazId: text("local_markaz_id"),
  nationalMarkazId: text("national_markaz_id"),
  mergedIntoId: text("merged_into_id"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("idx_people_auth").on(t.authId),
  index("idx_people_markaz").on(t.markazId),
]);

export const objects = sqliteTable("objects", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  kind: text("kind").notNull(),
  parentId: text("parent_id"),
  title: text("title").notNull(),
  startAt: text("start_at"),
  endAt: text("end_at"),
  status: text("status").notNull().default("planned"),
  data: text("data").notNull().default("{}"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_objects_markaz_kind").on(t.markazId, t.kind),
  index("idx_objects_parent").on(t.parentId),
  index("idx_objects_start").on(t.startAt),
  index("idx_objects_workspace_page").on(t.markazId,sql`(CASE WHEN ${t.kind} IN ('jamaat','event','stay','team','duty','assignment') THEN 0 WHEN ${t.kind}='mashwara' AND COALESCE(CASE WHEN json_valid(${t.data}) THEN json_extract(${t.data},'$.visibility') ELSE NULL END,'markaz')<>'private' THEN 1 WHEN ${t.kind}='mashwara' THEN 2 WHEN ${t.kind}='place' THEN 3 ELSE 4 END)`,sql`${t.createdAt} DESC`,sql`${t.id} DESC`),
]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  jamaatId: text("jamaat_id").notNull(),
  personId: text("person_id").notNull(),
  role: text("role").notNull().default("member"),
  permissions: text("permissions").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("idx_memberships_jamaat_person").on(t.jamaatId, t.personId),
  index("idx_memberships_person").on(t.personId),
]);

export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  objectId: text("object_id"),
  subjectId: text("subject_id"),
  summaryJson: text("summary_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (t) => [index("idx_audit_markaz_created").on(t.markazId, t.createdAt),index("idx_audit_markaz_subject_created").on(t.markazId,t.subjectId,t.createdAt)]);

export const retentionPolicy = sqliteTable("retention_policy", {
  markazId:text("markaz_id").notNull(),
  category:text("category").notNull(),
  days:integer("days").notNull(),
  policyReference:text("policy_reference").notNull(),
  updatedBy:text("updated_by").notNull(),
  updatedAt:text("updated_at").notNull(),
},t=>[primaryKey({columns:[t.markazId,t.category]}),check("retention_policy_days_range",sql`${t.days} BETWEEN 1 AND 36500`)]);

export const ameerDecisions = sqliteTable("ameer_decisions", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  jamaatId: text("jamaat_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  subjectId: text("subject_id").notNull(),
  previousAmeerId: text("previous_ameer_id"),
  createdAt: text("created_at").notNull(),
}, (t) => [index("idx_ameer_decisions_jamaat_created").on(t.jamaatId, t.createdAt)]);

export const repairReviews = sqliteTable("repair_reviews", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  kind: text("kind").notNull(),
  targetId: text("target_id").notNull(),
  original: text("original").notNull(),
  status: text("status").notNull().default("needs-review"),
  createdAt: text("created_at").notNull(),
}, (t) => [index("idx_repair_reviews_markaz_status").on(t.markazId,t.status)]);

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  personId: text("person_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  mode: text("mode").notNull(),
  requiredEmail: text("required_email"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  claimedAt: text("claimed_at"),
  claimedAuthId: text("claimed_auth_id"),
}, (t) => [uniqueIndex("idx_invitations_token_hash").on(t.tokenHash),index("idx_invitations_markaz_person").on(t.markazId,t.personId)]);

export const claimRequests = sqliteTable("claim_requests", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  invitationId: text("invitation_id").notNull(),
  targetPersonId: text("target_person_id").notNull(),
  sourcePersonId: text("source_person_id").notNull(),
  claimantAuthId: text("claimant_auth_id").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: text("reviewed_at"),
}, (t) => [uniqueIndex("idx_claim_requests_invitation").on(t.invitationId),index("idx_claim_requests_markaz_status").on(t.markazId,t.status)]);

export const personCorrections = sqliteTable("person_corrections", {
  id: text("id").primaryKey(),
  markazId: text("markaz_id").notNull(),
  personId: text("person_id").notNull(),
  actorId: text("actor_id").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [index("idx_person_corrections_person_created").on(t.personId,t.createdAt)]);

export const routeAssert = sqliteTable("route_assert", {
  id: text("id").primaryKey().notNull(),
}, (t) => [check("route_assert_not_stale",sql`${t.id} <> 'stale'`)]);

export const mashwaraSeries = sqliteTable("mashwara_series", {
  id:text("id").primaryKey(),markazId:text("markaz_id").notNull(),anchorInstant:text("anchor_instant").notNull(),timeZone:text("time_zone").notNull(),frequency:text("frequency").notNull(),
  endCount:integer("end_count"),endDay:text("end_day"),nextIndex:integer("next_index").notNull().default(0),title:text("title").notNull(),templateData:text("template_data").notNull(),
  createdBy:text("created_by").notNull(),updatedAt:text("updated_at").notNull(),version:text("version").notNull(),
},t=>[index("idx_mashwara_series_markaz").on(t.markazId)]);

export const mashwaraOccurrences = sqliteTable("mashwara_occurrences", {
  seriesId:text("series_id").notNull(),position:integer("position").notNull(),objectId:text("object_id").notNull(),originalStartAt:text("original_start_at").notNull(),exception:integer("exception").notNull().default(0),
},t=>[primaryKey({columns:[t.seriesId,t.position]}),uniqueIndex("idx_mashwara_occurrence_object").on(t.objectId)]);

export const mashwaraSeriesChanges = sqliteTable("mashwara_series_changes", {
  id:text("id").primaryKey(),seriesId:text("series_id").notNull(),startIndex:integer("start_index").notNull(),anchorInstant:text("anchor_instant").notNull(),timeZone:text("time_zone").notNull(),frequency:text("frequency").notNull(),title:text("title").notNull(),templateData:text("template_data").notNull(),createdAt:text("created_at").notNull(),
},t=>[uniqueIndex("idx_mashwara_series_change_start").on(t.seriesId,t.startIndex)]);

export const mashwaraUmoorTemplates = sqliteTable("mashwara_umoor_templates", {
  id:text("id").primaryKey(),seriesId:text("series_id").notNull(),startIndex:integer("start_index").notNull(),endIndex:integer("end_index"),title:text("title").notNull(),notes:text("notes").notNull(),createdBy:text("created_by").notNull(),version:text("version").notNull(),
},t=>[index("idx_mashwara_umoor_template_series").on(t.seriesId,t.startIndex)]);

export const mashwaraSeriesCollaborators = sqliteTable("mashwara_series_collaborators", {
  seriesId:text("series_id").notNull(),personId:text("person_id").notNull(),createdAt:text("created_at").notNull(),
},t=>[primaryKey({columns:[t.seriesId,t.personId]})]);

export const barakaOperations = sqliteTable("baraka_operations", {
  markazId:text("markaz_id").notNull(),jamaatId:text("jamaat_id").notNull(),idempotencyKey:text("idempotency_key").notNull(),
  operationKind:text("operation_kind").notNull(),payloadJson:text("payload_json").notNull(),resultId:text("result_id").notNull(),
  originalId:text("original_id"),replacementId:text("replacement_id"),createdBy:text("created_by").notNull(),createdAt:text("created_at").notNull(),
},t=>[primaryKey({columns:[t.jamaatId,t.idempotencyKey]}),uniqueIndex("idx_baraka_operations_result").on(t.resultId),uniqueIndex("idx_baraka_operations_original").on(t.originalId),index("idx_baraka_operations_markaz").on(t.markazId)]);

export const recordedRevisions = sqliteTable("recorded_revisions", {
  id:text("id").primaryKey(),markazId:text("markaz_id").notNull(),objectId:text("object_id").notNull(),kind:text("kind").notNull(),
  actorId:text("actor_id").notNull(),reason:text("reason").notNull(),beforeJson:text("before_json").notNull(),afterJson:text("after_json").notNull(),createdAt:text("created_at").notNull(),
},t=>[index("idx_recorded_revisions_object").on(t.objectId,t.createdAt),index("idx_recorded_revisions_markaz").on(t.markazId)]);

export const directoryCandidates = sqliteTable("directory_candidates", {
  osmId:text("osm_id").primaryKey(),dataJson:text("data_json").notNull(),state:text("state").notNull(),checkedAt:text("checked_at").notNull(),expiresAt:text("expires_at").notNull(),
},t=>[index("idx_directory_candidates_expires").on(t.expiresAt)]);
