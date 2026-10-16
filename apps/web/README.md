# Browser notes application

Memory-only React/TypeScript application consuming the packaged `@locho/web` SDK,
not repository source or generated WASM internals. Uses the canonical API v1 in
`../../contracts`; no separate backend implementation.

## Fresh setup (repository root)

Use Node 24.18.0/npm 11.16.0. Authenticate GitHub CLI for artifact download, or
provide `LOCHO_SDK_ARCHIVE` pointing to the exact SDK tarball:

```sh
npm run sdk:setup
npm ci
npm run check
npm run seed
npm run dev:api
# separate terminals:
locho host --config deploy/locho.toml
locho share sample-api --config deploy/locho.toml --ticket
npm run dev:web
```

Paste the ticket in the app, then use the documented disposable development users
from the root README. Ticket input and password fields clear after submission.
The host must support ticket v1 (Locho PR #91 or later). The app validates health
identity/version before login. A peer connection alone is not API readiness.

SDK pin: `0.1.0-dev.1`, source `4f8aa20c3bcbabb667ef2354510bdb101d690fa6`, CI run
`38776038252`, artifact `locho-web-npm-package`, tarball SHA-256
`5f4c1c87c34240567e8b9cd1d2472cc1b689e343089ebb17168d596b4df2cc7a`.
The setup script verifies this hash; npm lock additionally pins integrity. Artifacts
can expire: keep an immutable local copy and supply `LOCHO_SDK_ARCHIVE` when needed.
No npm registry publication is assumed. Artifact upgrades require reviewed pin,
checksum and compatibility changes together.

## Application behavior

- Ticket and backend token remain in memory only. Fresh page loads start unpaired.
- Disconnect closes transport, retains pairing/token in the current tab, and hides
  notes. Explicit reconnect rechecks health and `/api/me` before restoring notes.
- Logout removes the local token even offline; reachable logout revokes the current
  backend session. Failure reports unconfirmed server revocation. Pairing remains.
- Forget clears pairing/token and closes transport; local forget is not revocation.
- Switching host/service clears the old token; rotating the same scope retains it
  only subject to session revalidation. Scope uses full host/service/type.
- Authenticated 401 clears the token and notes, retaining healthy pairing. Failed
  login stays on login. Arbitrary error bodies/exception strings are not displayed.
- One client owner, generation checks, AbortSignal teardown and disabled duplicate
  submissions prevent stale results and accidental mutation replay. Interrupted
  writes have unknown outcome; refresh explicitly to confirm.
- Request deadline is 15 seconds; SDK response limit is 8 MiB. Contract bounds are
  100 notes, title 200 scalar values, body 16000 UTF-8 bytes. React renders text,
  never backend HTML.
- `pagehide` disconnects. Restoration requires explicit reconnect. Automatic
  background/recovery monitoring, BFCache auto-restore, status subscriptions and
  remembered sessions are follow-ups, not claims of this memory-only slice.

## Verification and deployment

```sh
npm run check
npx playwright install chromium firefox webkit
LOCHO_BINARY=/absolute/path/to/pinned/locho npm run test:browser
```

The browser fixture creates an isolated backend/database and users, starts a real
CLI host with public N0 discovery, generates a fresh ticket and cleans up resources.
Six production UI tests pass locally across Chromium/Firefox/WebKit: CRUD, isolation,
reconnect, logout/forget, malformed ticket and failed login. Controller tests cover
late-connect cleanup, interrupted writes, 401 and token scoping. No screenshots,
video or traces are collected because pairing/auth screens contain credentials.
This uses public infrastructure and can fail during N0 outages. It is not controlled
relay, physical mobile browser or HTTPS deployment acceptance.

Deploy `apps/web/dist` as static assets over HTTPS. Serve `.wasm` with
`application/wasm`; CSP must permit modules/WebAssembly compilation and HTTPS/WSS
N0 discovery/relays. Keep third-party scripts and analytics off credential pages.
The API remains private behind Locho, not public ingress. IndexedDB, QR, full
storage/page recovery, SSE/WebSockets and Flutter notes app remain later milestones.
