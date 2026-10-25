# Browser notes application

React/TypeScript application demonstrating service-worker cookie sessions and optional
bearer/remembered sessions. It consumes an installed `locho_web` package,
not repository source or generated WASM internals. Uses the canonical API v1 in
`../../contracts`; no separate backend implementation.

## Fresh setup (repository root)

Use Node 24.18.0/npm 11.16.0. Dependencies come directly from the public npm
registry with committed lockfile integrity:

```sh
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

SDK pin: [`locho_web` 0.1.0-beta.3](https://www.npmjs.com/package/locho_web/v/0.1.0-beta.3),
including the metadata APIs. `package-lock.json` pins its registry URL and SHA-512 integrity. No `vendor/`,
GitHub credentials, Rust compiler or SDK build scripts are needed for the browser
application. Upgrade the exact dependency, lockfile and compatibility record together.

`npm run dev:web` builds both the page and worker, then serves production assets at
`http://127.0.0.1:5173`. Rerun it after source edits. This deliberately avoids a
development-only worker path. HTTPS (or trusted localhost) is required.

## Cookie sessions (default)

Choose **Cookie session (service worker)** or visit `/?auth=cookie`. Pair, log in,
and use the same notes CRUD/live-update UI. The worker owns the Locho client and
cookie; the page receives user/expiry and sanitized JSON/stream responses only.
There is no remember option, browser-cookie-jar update or automatic credential
restore. Explicit disconnect clears authentication. Reconnect retains a surviving
worker's pairing but requires login. Fresh loads and worker loss require pairing.

Switching tickets, including the same service's replacement ticket, clears cookie
authentication. Tabs have independent worker owners and sessions. Logout attempts
server revocation and always removes local auth; offline revocation is unconfirmed.
The worker handles only reserved gateway requests, never arbitrary URLs/HTML.
Same-origin scripts remain trusted; this is not native HttpOnly/XSS isolation.

See [architecture, security and acceptance](../../../docs/cookie-sessions.md).

## Bearer application behavior (explicit `/?auth=bearer`)

Select **Bearer session** to use the existing flow below. Existing saved bearer
credentials are neither loaded nor migrated in cookie mode. Switching modes closes
the active transport; saved bearer credentials remain until explicitly forgotten in
bearer mode. This is intentional, not a promise that switching mode erases storage.

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
- The SDK provides Rust-watch-backed subscriptions. One owned observer
  hides notes on reconnecting and recreates/revalidates after recovery; no interval
  polling or mutation replay. Teardown unsubscribes before client close; generation
   guards discard late callbacks. Real network-transition evidence remains future
   work. Tabs own independent backend sessions; logout revokes only its own token.

## Live note updates

The SDK streaming API carries bearer-authenticated `/api/events`, or worker-managed
cookie-authenticated `/browser/api/events`. One owned event
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

Current acceptance status is in [cookie-session acceptance](../../../docs/cookie-sessions.md):
published beta.3 passes the full local matrix (55 passed, five expected skips),
including the previously failing Firefox restore/re-pair journeys. The earlier
candidate failures are retained as historical evidence, not current beta.3 failures.
Compose/HTTPS and mobile interoperability still require separate acceptance.

The earlier bearer suite passed 27 cases including host restart, stopped upstream,
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
The API remains private behind Locho, not public ingress. Browser↔Flutter live-event
acceptance is documented in `docs/events.md`; WebSockets and real
mobile/BFCache/network acceptance remain follow-ups.
