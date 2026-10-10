# Deploy My Jamaat to Render Free with Turso

Updated **10 October 2026**. Adapted for this app from the supplied StudentDashboard guide.

## Current state

The Render runtime supports external **Turso libSQL (SQLite-compatible)** storage. `render.yaml` now selects **Free** compute, contains **no disk**, and prompts for credentials privately. The free My Jamaat workspace and an empty Turso database were created; the service has not been deployed and real Google sign-in has not been configured. Local libSQL tests are not proof of a working live Turso connection or Render redeploy.

| Target | Build | Start | Identity | Database |
|---|---|---|---|---|
| Existing Sites | `npm run build` | Sites / local Wrangler | Hosting-verified ChatGPT identity | D1 |
| Render Free | `npm run build:render` | `npm run start:render` | Verified Google OAuth and opaque sessions | Remote Turso libSQL |
| Optional local/paid SQLite | Same Render build | Same Render start | Same Google OAuth | Explicit `SQLITE_PATH`; paid Render disk required |

The public GitHub repository includes source, migrations and synthetic tests. Private deployment evidence, credentials and real records remain excluded. The old Site remains available; its audience and database have not been changed.

## Durable external storage

Use Turso's **SQLite/libSQL** engine for the existing migrations. The new Turso Rust engine is a separate option and has not been tested with this app. All application records, sessions and login attempts are written directly to the remote primary. There is **no embedded local replica or filesystem-dependent session store**.

The adapter preserves prepared bindings, returned rows, D1 result shapes and atomic batches. Batch metadata is read on the same backend connection, including trigger changes. Each migration and its SHA-256 tracker row commit together; changed previously applied migrations fail. Migration startup completes before the server listens. Failed statements roll back linked routes, ledger records and audit rows together.

Database calls in session/auth/health handling are asynchronous. Sign-in state consumption is atomic; the pending-login cap is enforced within a write transaction. Health checks actually query the configured database; remote failures return a generic 503. HTTP database calls have a ten-second bound and do not automatically retry writes. [Official libSQL client reference](https://docs.turso.tech/sdk/ts/reference).

## Cost and limits

- Render workspace: **Hobby**, $0 workspace fee.
- Render web service: **Free**, no disk, one instance.
- Turso organization: **Free**. Keep paid plans and usage overages disabled; stay within the provider's included limits.

Render Free sleeps after 15 minutes of inactivity; the next request can take about a minute to start. Render's local files are ephemeral. The remote database retains records independently of that filesystem. Free compute has usage limits and is intended for previews/hobby use; these limits and a free workspace do not constitute a production-readiness guarantee. [Render Free](https://render.com/docs/free), [Turso pricing](https://turso.tech/pricing).

## Local acceptance

Use pinned Node 24.19.0. Never use ordinary/production data for fixture tests.

```sh
npm run install:ci
npm run build:render
node audit/turso-storage-test.mjs
node audit/render-runtime-test.mjs --libsql
node audit/route-planning-test.mjs
node audit/repair-test.mjs all --runtime=turso --output=/tmp/my-jamaat-turso-verification.json
npx tsc --noEmit
```

These commands use the official libSQL client against disposable local SQLite files, with synthetic records and database-backed session cookies. OAuth tests use synthetic RSA certificates with the real Google JWT verifier and stub provider transport. They check migration failures, rollback, permissions, concurrency, routes, sessions, local restart and isolated backup restore. They do **not** test live provider credentials, internet transport, actual cloud backups or a real Render restart.

`node audit/render-browser-server.mjs --libsql` prints disposable persona URLs. Stop it with Ctrl+C to remove temporary storage. Never deploy the audit proxy. `node audit/render-runtime-test.mjs` still checks the original local Node SQLite adapter.

Both builds share `dist/`; stop servers before switching. Existing-target compatibility commands:

```sh
npm run build
node audit/repair-test.mjs dependency-smoke --output=/tmp/my-jamaat-sites-smoke.json
```

## Render form / Blueprint

The Blueprint is already in the public repository. Its presence does not create resources. Use the existing **My Jamaat** workspace and verify **Free** is selected before submitting the service form.

| Field | Value |
|---|---|
| Repository | `https://github.com/IhsanEF/MyJamaat` |
| Branch | `main`, verified Turso integration commit |
| Name | `my-jamaat` or an available equivalent |
| Language | Node |
| Region | Oregon (US West), matching the selected database region |
| Root Directory | Blank |
| Build Command | `npm run install:ci && npm run build:render` |
| Start Command | `npm run start:render` |
| Compute | **Free** |
| Disk | **None** |
| Health Check Path | `/api/health` |
| Pre-Deploy Command | Blank; migrations run during startup |
| Auto-Deploy | Off during setup |

No broader GitHub access is necessary when the existing integration already lists MyJamaat. Public Git Repository is an alternative. Do not grant new scopes or select another workspace silently.

## Private environment variables

| Variable | Setting |
|---|---|
| `NODE_ENV` | `production` |
| `TURSO_DATABASE_URL` | Database URL shown by Turso, `libsql://…` (TLS) or HTTPS |
| `TURSO_AUTH_TOKEN` | A token scoped to this database with read/write access, entered privately |
| `GOOGLE_CLIENT_ID` | My Jamaat Web application OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Its secret, entered privately |
| `ALLOWED_SIGN_IN_EMAILS` | Comma-separated approved Google accounts for the pilot |
| `PORT` | Render default 10000 |
| `RENDER_EXTERNAL_URL` | Automatically supplied actual public origin |
| `PUBLIC_ORIGIN` | Optional exact origin override for a custom domain |

Leave **SQLITE_PATH unset on Render Free**. Remote storage takes precedence over the optional local adapter. Render configuration rejects a file URL masquerading as Turso. Missing remote token, Google client or pilot allowlist fails startup. Credentials must never be pasted into chat, logs, commits, screenshots or fixture files. The user creates and enters new credentials privately in provider interfaces.

## Google sign-in

Signing into Turso with GitHub signs into the database provider. My Jamaat's end users use Google OAuth.

Configure a Google **Web application** client for My Jamaat with the exact callback:

```text
https://ACTUAL-RENDER-HOST/auth/google/callback
```

Do not guess a live service URL. Configure consent/test users as required by Google. Only openid/email/profile scopes are requested; no Firebase service account, Gemini key or broad Cloud IAM role is needed.

Google signatures, issuer, audience, expiry, verified email, state/nonce and PKCE are checked. Seven-day opaque sessions are stored as hashes in the database. Logout revokes them; pilot allowlist removal takes effect on the next request. Caller hosting/forwarding/fixture headers cannot authenticate. Origins govern redirects and CSRF checks; HTTPS cookies are Secure, HttpOnly, SameSite and __Host scoped.

## Backups, existing data and release gate

Use Turso's database-scoped **Download SQLite File** export or documented backup/recovery workflow. Keep exports private and restore a copy into an isolated database before any cutover. `scripts/backup-render.mjs` is only for the explicit local/paid SQLite adapter and refuses a configured Turso URL. Its local-file backup is not a remote cloud backup. Actual Turso export/restore authority and live recovery remain unverified. [Turso backups](https://docs.turso.tech/features/point-in-time-recovery).

Existing hosting identities and Google subject IDs differ. Do not merge accounts automatically by name/email. The old database has not been transferred; any real-data migration requires an explicit identity/data plan and authorized trial restore.

After private configuration, deploy the verified commit and inspect actual logs. Verify direct health 200, real Google login/logout, rejected forged/expired/revoked sessions, intended permissions, imports/history/export, and a 2/3/1-day route across three masajid. Confirm actual Turso persistence after Render restart/spindown/redeploy, export/isolated restore, and desktop/mobile behavior. Record the real URL, deployed commit and evidence. Local passes do not close these live gates.
