# Browser notes application

React/TypeScript application with opt-in remembered sessions consuming the packaged `@locho/web` SDK,
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

SDK pin: `0.1.0-dev.3`, source `e5faa3f320c9c142dbc155ac8e4a27e01a0c0d7f` (Locho #98), CI run
`38932541782` (test-merge build `8a9e67e3fbe978a1f62ff1782ba7b183af568b7f`), artifact `locho-web-npm-package`, tarball SHA-256
`83ea65e191af93a40cc1b652642e4335ef044ebb39fa31b64488ef736d5e091c`.
The setup script verifies this hash; npm lock additionally pins integrity. Artifacts
can expire: keep an immutable local copy and supply `LOCHO_SDK_ARCHIVE` when needed.
No npm registry publication is assumed. Artifact upgrades require reviewed pin,
checksum and compatibility changes together.

## Application behavior

- Remember disabled: ticket/token remain in memory only; fresh loads start unpaired.
  Remember enabled: an IndexedDB v1 record stores ticket and optional backend auth,
  keyed by full host/service/type. One selected pairing is retained; switching scopes
  replaces the record atomically rather than forwarding another attachment's token.
  Passwords and notes are never persisted. All scripts on this origin can access
  stored credentials: IndexedDB is not HttpOnly isolation or encryption.
- Startup restores only after health identity/version and `/api/me` validation.
  Invalid/expired/revoked auth removes the saved token while keeping pairing.
- Turning remember off removes persisted ticket/token while retaining the current
  live session. Forget removes the record and memory state. Writes are serialized,
  obsolete queued saves are discarded, and in-flight writes precede the final delete.
  Storage failure is visible and offers retry; deletion failure means saved values
  may remain. Clear site data if removal cannot complete. Private browsing, eviction,
  site-data clearing and inaccessible/invalid records can require pairing again.
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
- `pagehide` aborts work and closes the client, retaining explicit connection intent.
  `pageshow` reconnects only when that intent survives; disconnect/logout/forget
  prevents automatic resurrection. Health/me validation precedes restored content.
  Async cleanup during page destruction is best effort. Tests dispatch persisted
  page events; actual BFCache entry is browser/environment-dependent and unproven.
- The dev.2 SDK provides Rust-watch-backed subscriptions. One owned observer
  hides notes on reconnecting and recreates/revalidates after recovery; no interval
  polling or mutation replay. Teardown unsubscribes before client close; generation
   guards discard late callbacks. Real network-transition evidence remains future
   work. Tabs own independent backend sessions; logout revokes only its own token.

## Live note updates

The dev.3 streaming API carries bearer-authenticated `/api/events`. One owned event
watch per authenticated foreground session subscribes before the canonical list
refresh. Same-user changes in other tabs/devices invalidate the list; notes are
reloaded from the API. Editor drafts and unknown-write messages survive background
refresh. A live-update status is separate from transport and user authentication.

Parsing handles fragmented UTF-8, CR/LF/CRLF, comments and multiline data, with a
4096-byte line/event budget and strict NoteChange fields. Unknown event names/id/retry
are ignored. Invalid/truncated UTF-8, malformed JSON/schema and oversized frames close
the reader and enter recovery. There is no event history or Last-Event-ID replay.

Bursts coalesce into one list request and one dirty follow-up per in-flight request.
Refreshes serialize with other list reads, defer during user actions, and reject stale
authenticated results after token removal. Events never acknowledge a write or replay it.

On EOF/reset/idle timeout/parser failure: retain notes, show reconnecting, retry with
exponential backoff (1s initial, jitter, 30s cap; stable 30s stream resets backoff).
429 respects integer Retry-After up to 300s. Each retry validates health/me, subscribes,
then refreshes canonical notes to recover missed changes. 401 clears auth/persisted
token while retaining pairing. Failed background refresh also restarts the watch.
Explicit disconnect/logout/forget/host switch/pagehide cancel readers and retry timers;
pageshow restores only surviving connection intent. Actual BFCache remains unverified.

## Verification and deployment

The extended suite now passes 27 cases including host restart, stopped upstream,
committed-but-lost POST/PATCH/DELETE responses with no replay, and a new page owner
restoring a remembered session. See [JSON failure acceptance](../../../docs/json-acceptance.md)
in the repository root (`docs/json-acceptance.md`) for reproduction and limitations.

```sh
npm run check
npx playwright install chromium firefox webkit
LOCHO_BINARY=/absolute/path/to/pinned/locho npm run test:browser
```

The browser fixture creates an isolated backend/database and users, starts a real
CLI host with public N0 discovery, generates a fresh ticket and cleans up resources.
Eighteen production UI tests pass locally across Chromium/Firefox/WebKit: CRUD,
isolation, reconnect, logout/forget, malformed tickets, failed login, IndexedDB
restore/deletion, revoked saved tokens, storage failure and page-event restoration.
Eleven controller tests cover late-connect cleanup, interrupted writes, 401/token
scoping, storage races, remember-off, failed deletion and recovery policy. No screenshots,
video or traces are collected because pairing/auth screens contain credentials.
This uses public infrastructure and can fail during N0 outages. It is not controlled
relay, physical mobile browser or HTTPS deployment acceptance.

Deploy `apps/web/dist` as static assets over HTTPS. Serve `.wasm` with
`application/wasm`; CSP must permit modules/WebAssembly compilation and HTTPS/WSS
N0 discovery/relays. Keep third-party scripts and analytics off credential pages.
The API remains private behind Locho, not public ingress. Flutter event consumers,
WebSockets and real mobile/BFCache/network acceptance remain follow-ups.
