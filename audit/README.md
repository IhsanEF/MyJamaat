# Synthetic regression tests

All fixture identities and records are synthetic. These tools use disposable local databases and loopback listeners. Never apply fixture SQL to production. Node 22.13 or later is required.

After installing dependencies with npm run install:ci and building with npm run build:

- node audit/route-planning-test.mjs
- node audit/repair-test.mjs route --output=/tmp/my-jamaat-route-verification.json
- node audit/repair-test.mjs all --output=/tmp/my-jamaat-full-verification.json

The browser harness prints a disposable proxy port and accepts an optional output manifest path. Use a persona host such as http://markaz-ameer.localhost:PORT/. Stop it with Ctrl+C to delete its temporary database.

Private audit reports, screenshots, production readbacks, and the original deployment Git history are excluded from this public source snapshot.
