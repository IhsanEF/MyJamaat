CREATE TABLE `route_assert` (
	`id` text PRIMARY KEY NOT NULL,
	CONSTRAINT "route_assert_not_stale" CHECK("route_assert"."id" <> 'stale')
);
