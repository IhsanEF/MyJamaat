# Deploy My Jamaat to Render

Updated **4 October 2026**. Adapted for My Jamaat from the supplied StudentDashboard guide.

## Implementation and current status

The repository now has two build targets:

| Target | Build | Start | Identity | Database |
|---|---|---|---|---|
| Existing Sites app | `npm run build` | Existing Sites hosting / local Wrangler preview | Hosting-verified ChatGPT identity | D1 |
| Render | `npm run build:render` | `npm run start:render` | Server-verified Google OAuth and opaque sessions | SQLite on a persistent disk |

Render engineering is implemented and locally verified. **No Render service has been created or deployed yet.** The outstanding prerequisites are the user's choice/approval of paid storage, Google OAuth client configuration, and approved pilot accounts. Live Google login and persistence through an actual Render redeploy remain release gates.

Local acceptance evidence is recorded in the private repair status. The public repository contains runnable synthetic tests, not private evidence or a production database backup.

## What was implemented

- A production Vinext Node build using the repository's pinned framework. It listens on `0.0.0.0` and `PORT` (default `10000`).
- An isolated build alias replaces Cloudflare bindings and ChatGPT identity helpers only for the Render build. The existing Sites target keeps its hosting authentication.
- A D1-compatible SQLite adapter for prepared statements, returned rows/change counts, and atomic batch rollback. Fourteen existing forward migrations are tracked by filename and SHA-256 and applied once during startup. Changed previously applied SQL fails startup.
- Google authorization code login with PKCE, state, nonce, signature/issuer/audience/expiry verification through Google's official library, verified email and an explicit pilot allowlist. Stable identities are `google:<subject>`, not email/name matches.
- Random opaque seven-day sessions, hash-only database storage, HttpOnly/SameSite cookies, Secure/`__Host-` cookies on HTTPS, logout revocation, and per-request pilot allowlist checks.
- Caller identity and forwarding headers are discarded. A configured public origin governs callback URLs and the API's same-origin checks. Authenticated pages and APIs are private/no-store.
- Sign-in/sign-out forms with CSRF protection, a visible dashboard sign-out link and accessible touch targets.
- `/api/health`: direct `200` when the database is ready, bounded `503` on database failure, no authentication redirect or private records.
- Consistent SQLite backup tooling and synthetic restore/restart tests. Production startup never seeds audit fixtures.

The Google library is used for individual user OAuth; this app does **not** need StudentDashboard's Firebase service account, Gemini key or broad Google Cloud IAM roles. [Google authentication library](https://github.com/googleapis/google-cloud-node-core/tree/main/packages/google-auth-library).

## Local verification commands

Use the pinned Node version in `.node-version` (Node 24). From the repository root:

```sh
npm run install:ci
npm run build:render
node audit/render-runtime-test.mjs
node audit/route-planning-test.mjs
node audit/repair-test.mjs all --runtime=node --output=/tmp/my-jamaat-render-verification.json
```

All tests use disposable synthetic databases. The runtime tests stub Google's provider transport with synthetic RSA certificates while retaining its real token verifier. They do not establish a successful live Google OAuth login.

For a disposable browser walkthrough:

```sh
node audit/render-browser-server.mjs
```

Use the printed persona URL. The proxy supplies real random database-backed session cookies; the production server still verifies them. Stop the harness with Ctrl+C to delete its disposable files. Never deploy this proxy or use audit fixtures for real records.

Build targets share `dist/`; stop local servers before switching targets. To verify the existing target separately:

```sh
npm run build
node audit/repair-test.mjs dependency-smoke --output=/tmp/my-jamaat-sites-smoke.json
```

## Render service configuration

The checked-in `render.yaml` is an optional reviewed Blueprint. **Applying it creates paid resources.** Its presence in GitHub does not create a service or authorize charges.

The prepared dashboard form uses the public Git repository. The connected Git provider currently lists another repository; using the public source does not require granting Render broader GitHub access. For interactive setup, guide one navigation/action at a time and give all fields together when completing a form.

| Field | Value |
|---|---|
| Source | `https://github.com/IhsanEF/MyJamaat` |
| Name | `MyJamaat` / an available name agreed by the user |
| Language | Node |
| Branch | `main`, at the verified portability commit |
| Region | Oregon (US West) |
| Root Directory | Blank |
| Build Command | `npm run install:ci && npm run build:render` |
| Start Command | `npm run start:render` |
| Health Check Path | `/api/health` |
| Compute | Paid service with 512 MB RAM, currently shown as US$7/month |
| Disk mount | `/var/data` |
| Disk size | 1 GB, currently shown as US$0.25/GB/month |
| Pre-Deploy Command | Blank; the disk is used at startup, where migrations run |
| Auto-Deploy | Off during the pilot |

The dashboard displayed these prices on 4 October 2026; review the actual totals/terms before creating anything. A persistent disk requires paid compute. Render Free's filesystem is ephemeral and cannot preserve these SQLite records. [Render web services](https://render.com/docs/web-services), [persistent disk restrictions](https://render.com/docs/disks), [free service limitations](https://render.com/docs/free).

A disk allows one service instance and disables zero-downtime deploys. Keep the service at one instance. Back up before migrations or significant changes.

## Environment variables

Have the user enter real OAuth values directly into Render. Never ask for secrets in chat, print them, commit `.env` files, or use synthetic test values in production.

| Variable | Setting |
|---|---|
| `NODE_ENV` | `production` |
| `SQLITE_PATH` | `/var/data/my-jamaat.sqlite` |
| `GOOGLE_CLIENT_ID` | The app's Web application OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Its secret, entered privately in Render |
| `ALLOWED_SIGN_IN_EMAILS` | Comma-separated Google accounts approved for the pilot |
| `PORT` | Render supplies this automatically; the prepared form uses `10000` |
| `RENDER_EXTERNAL_URL` | Render supplies the actual service origin automatically |
| `PUBLIC_ORIGIN` | Optional origin override for a custom domain; omit for the normal Render URL |

The server refuses missing Google configuration or an empty pilot allowlist. On Render it requires `SQLITE_PATH` under `/var/data`. The declared disk must actually be attached there. Locally, use the secret-free `.env.render.example` as a reference; start commands read the process environment, so source/load local values before running them.

Opaque sessions do not need a separate signing secret. Expired sessions, invalid cookies and accounts removed from the allowlist cannot authenticate.

## Google OAuth setup

Use an OAuth **Web application** client authorized for My Jamaat. Do not reuse StudentDashboard's service account or assume its existing client is authorized for this app.

In Google Auth Platform, configure the application's consent/test users and register the exact callback for the real Render origin:

```text
https://ACTUAL-RENDER-HOST/auth/google/callback
```

For an explicitly configured custom origin, register that origin's corresponding callback. Only `openid`, `email`, and `profile` scopes are requested. The user completes credential creation/entry privately in Google's/Render's interfaces. The actual service host is not established until Render creates it; do not present a guessed URL as live.

First login on a fresh database presents Markaz creation. Later approved users use the existing Markaz joining/invitation flow. The allowlist establishes pilot entry only; all Markaz/Jamaat roles and sensitive scopes are still checked by the existing API.

## Existing records and cutover

The existing app remains available. This migration does not transfer its database or change its audience. Existing hosting IDs and Google subject IDs differ; do not automatically merge by name or email. Import/claim records through the reviewed invitation/account-claim flow, or plan an explicit authorized migration and trial restore before any cutover involving real records.

Keep backups private. On a running Node host, a consistent backup can be created with:

```sh
node scripts/backup-render.mjs /PRIVATE/NEW/BACKUP.sqlite
```

`SQLITE_PATH` must be set; the script refuses an existing destination. Copy backups privately outside Render. A local file copy of a live WAL database is not equivalent to this consistent backup. Restore only while the destination service is stopped, preserve the prior database, and test the restored copy in isolation first.

## Live release gate

After the user approves/configures the service, deploy the verified commit and inspect actual build/startup logs. Verify:

1. Direct `/api/health` `200`; failed/unavailable storage does not report healthy.
2. Real Google login and logout with the exact registered callback; unknown/expired sessions and forged hosting headers are denied.
3. Approved pilot users retain their intended Markaz/Jamaat permissions; revoked pilot accounts are denied immediately.
4. A route with 2, 3 and 1 days at separate masajid, host confirmation, daily venue selection, route edits and calendar placement.
5. Imports, optional contacts, daily/recurring Mashwaras, Khidmah assignments, Baraka corrections, history and CSV export.
6. Persistence through a real Render restart/redeploy and a private backup/isolated restore.
7. Desktop and narrow mobile viewport behavior. Do not claim physical-device or screen-reader testing unless performed.

Record the exact deployed commit, actual URL and results. Local passing tests and Render's live badge do not complete this gate. [Render health checks](https://render.com/docs/health-checks).
