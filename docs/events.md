# Authenticated note events — API v1 / OpenAPI 1.1.0

`GET /api/events` accepts the ordinary backend `Authorization: Bearer ...` session.
It returns `text/event-stream; charset=utf-8`, `Cache-Control: no-store` and
`X-Accel-Buffering: no`. Missing/invalid/expired/revoked auth fails before streaming
with the existing 401 JSON error. Service capability and user auth remain separate.

An initial `: connected` comment is flushed without waiting for a mutation.
Successful committed note creation, update and deletion emit:

```text
event: note.changed
data: {"operation":"updated","noteId":"opaque-note-id"}

```

Schema: `contracts/schemas.json#/definitions/NoteChange`. No note content, email,
password, token, ticket or user ID is sent. Only the authenticated owner's changes
are delivered; another user's rejected operations do not produce events. Events
are invalidations, not database replication or mutation acknowledgments.

## Delivery, lifetime and limits

- One process-local hub, no history, replay, IDs or Last-Event-ID handling.
  Reconnection starts with future changes only. Refresh the full notes list after
  validating health and `/api/me`; never replay interrupted application mutations.
- One shared 30-second heartbeat/session-check timer (tests may shorten to 10 ms
  minimum). Heartbeat comments keep application traffic below Locho's TCP idle
  deadline. Expiry/revocation is checked before every event and on each timer tick.
- Logout immediately closes streams for that session only; other sessions survive.
  Revoked/expired and slow streams terminate with EOF or a transport reset. No
  credential-bearing error body is written into an established stream.
- Four streams per user across all their sessions, 64 total. Excess returns 429
  `rate_limited` with `Retry-After: 30` before headers are sent.
- Frame cap 1024 bytes; stream high-water mark 4096 bytes. No application event
  queue: if Node reports backpressure, disconnect that subscriber. Node socket
  buffers are additionally bounded by the runtime/OS; this is not a whole-process
  exact-memory guarantee. Admission capacity releases on socket/stream close.
- Cancellation destroys the stream. API shutdown closes the hub/timer and active
  HTTP connections before database close. Failed database checks fail streams closed.
- Events are published after successful database mutation, before application HTTP
  response delivery. A response can be lost while an event/list shows the write.

## Evidence and rollout

The 2026-10-17 registry beta rerun is recorded in registry-acceptance.md. Both apps
now consume published 0.1.0-beta.1 SDKs. Historical dev-package results below are
retained separately. The latest browser matrix passes after restore persistence/401
fixes; earlier post-reload health-check timeouts remain unexplained. Android and
cross-platform event acceptance pass.

Live localhost HTTP tests prove events arrive while the stream remains open,
CRUD operation framing, two-user isolation, no replay, admission rejection,
capacity reclamation, session-specific logout, idle expiry and active shutdown.
Hub tests verify slow-consumer disconnection and the aggregate cap. JSON tests and
contract validation remain unchanged gates.
The CLI TCP smoke also verifies the connected comment and a committed creation
event incrementally through a real host/attachment, before closing the stream.
Local verification: `npm run check` (12 API tests, 12 browser controller tests,
build/typecheck/contract validation), `npm run smoke:locho`, and the three-browser
Playwright matrix (27 passed; three deployment-only cases skipped in this local
mode). CI runs the tunnel smoke alongside the existing browser/deployment gates.

Browser consumes packaged dev.3 `fetchStream()` and now subscribes automatically
for an authenticated foreground session. See apps/web/README.md for bounded parsing,
refresh coalescing, backoff, missed-change recovery and ownership. Buffered `fetch()`
remains unsuitable for infinite SSE; native EventSource cannot address Locho host IDs
or supply this bearer-header flow. Flutter now consumes ordinary streamed Dart HTTP
through loopback with setup/idle, rather than full-body lifetime, timeouts. Its event
watch, bounded parser, coalesced refresh, backoff and auth cleanup match browser policy.
See apps/flutter/README.md for exact reproduction and dependency injection.

Browser verification adds eight deterministic parser/ownership/recovery tests
(20 browser unit tests total) and nine production UI cases across three engines:
same-user live CRUD, isolation, missed changes during event outage, draft retention,
idle expiry with saved-token removal, and repeated page-event cleanup. The previous
JSON/browser failure matrix remains a gate. Local full run passed 35/36 active
cases; one Firefox remembered-restore N0 timeout passed a focused rerun. Private
Compose and internal-CA HTTPS/CSP/WASM acceptance passed all six deployment cases.
These are desktop browser results, not physical/mobile or actual BFCache evidence.

Cross-platform runtime acceptance (`node scripts/flutter-fixture.mjs --events`, with
LOCHO_BINARY set) passes on the Android API 37 ARM64 16 KiB emulator and production
Chromium app using packaged Flutter dev.2/browser dev.3 SDKs. It covers bidirectional
CRUD, isolation, 65s stable connections across two real 30s heartbeats, missed-change
recovery, draft preservation, suspend/resume, logout and secure-token expiry cleanup.
Flutter adds eight event tests (28 total); existing host restart/upstream outage,
committed-but-lost mutation and autonomous release acceptance pass with events enabled.
This establishes emulator/desktop interoperability, not physical/mobile completeness.

Physical/mobile, authenticated custom relay, public HTTPS and broad network gates
listed in deployment/json-acceptance docs remain open; backend SSE does not close
them. WebSockets follow separately after streaming acceptance.
