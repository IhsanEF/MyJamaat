# Synthetic regression tests

Use the pinned Node 24.19.0 runtime. Fixtures contain synthetic identities and records; all tests use disposable local storage and loopback listeners. Never apply fixture SQL to production.

Install dependencies with `npm run install:ci`.

## Render Free / Turso target

```sh
npm run build:render
node audit/turso-storage-test.mjs
node audit/render-runtime-test.mjs --libsql
node audit/route-planning-test.mjs
node audit/repair-test.mjs all --runtime=turso --output=/tmp/my-jamaat-turso-verification.json
```

The runtime tests use synthetic signed Google tokens with the official verifier and stubbed provider transport. They use the official libSQL client on disposable local files. They test local restart and local backup/isolated restore, and do not claim live Google login, cloud transport, Turso recovery or Render restart persistence. Run without --libsql to verify the original local Node SQLite adapter.

`node audit/render-browser-server.mjs --libsql` prints a disposable persona URL. Its isolated proxy supplies random database-backed session cookies; the production server verifies them. Stop it with Ctrl+C to delete temporary storage. Never deploy the audit proxy.

## Existing Cloudflare target

```sh
npm run build
node audit/repair-test.mjs dependency-smoke --output=/tmp/my-jamaat-sites-smoke.json
node audit/repair-test.mjs all --output=/tmp/my-jamaat-full-verification.json
```

Build targets share `dist/`; stop servers before switching. The Cloudflare browser harness is `node audit/task-25-browser-server.mjs`.

Private reports, screenshots, production readbacks and original deployment Git history are excluded from public source. See the Render deployment guide for the separate live release gate.
