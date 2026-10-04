# Synthetic regression tests

Use the pinned Node 24.19.0 runtime. Fixtures contain synthetic identities and records; all tests use disposable local storage and loopback listeners. Never apply fixture SQL to production.

Install dependencies with `npm run install:ci`.

## Render target

```sh
npm run build:render
node audit/render-runtime-test.mjs
node audit/route-planning-test.mjs
node audit/repair-test.mjs all --runtime=node --output=/tmp/my-jamaat-render-verification.json
```

The runtime tests use synthetic signed Google tokens with the official verifier and stubbed provider transport. They test local restart and consistent backup/isolated restore, and do not claim live Google login or Render disk persistence.

`node audit/render-browser-server.mjs` prints a disposable persona URL. Its isolated proxy supplies random database-backed session cookies; the production server verifies them. Stop it with Ctrl+C to delete temporary storage. Never deploy the audit proxy.

## Existing Cloudflare target

```sh
npm run build
node audit/repair-test.mjs dependency-smoke --output=/tmp/my-jamaat-sites-smoke.json
node audit/repair-test.mjs all --output=/tmp/my-jamaat-full-verification.json
```

Build targets share `dist/`; stop servers before switching. The Cloudflare browser harness is `node audit/task-25-browser-server.mjs`.

Private reports, screenshots, production readbacks and original deployment Git history are excluded from public source. See the Render deployment guide for the separate live release gate.
