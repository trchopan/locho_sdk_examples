# Development roadmap and handoffs

## Current milestone: live note updates

- Backend authenticated `/api/events` and OpenAPI 1.1.0 merged in examples #8:
  scoped committed invalidations, bounded subscribers/backpressure, heartbeat,
  logout/expiry checks and no replay.
- Browser streaming transport merged in Locho #98: bounded pull-driven response
  bodies and setup/idle deadlines. This app pins the verified dev.3 tarball.
- Browser app now parses bounded SSE, coalesces canonical refresh, recovers missed
  changes after health/me validation and subscription, preserves drafts and unknown
  write messages, and cancels event readers/retry timers with session ownership.

## Flutter event consumers and cross-platform evidence

Flutter now uses streamed Dart HTTP through the existing loopback SDK attachment,
with a dedicated event client and setup/idle deadlines. Bounded parsing and
refresh/retry/auth policies match the browser. Android ARM64 16 KiB emulator plus
production Chromium pass bidirectional live CRUD, isolation, missed-change refresh,
draft retention, suspend/resume, logout/expiry and 65s real-heartbeat stability.
Host restart/interrupted writes and autonomous release acceptance also pass.
Flutter retains dev.2; no new native transport API is required. See events.md.

## Then: streaming acceptance and WebSockets

Packaged apps now have emulator/desktop evidence across heartbeat intervals,
old buffered deadlines, reconnects and cancellation. Broaden physical/mobile and
real-network acceptance before claiming full platform SSE completion. Physical
mobile runtime/network evidence is separate from emulator/desktop CI results.
Next protocol slice is authenticated `/api/ws` with bounded messages, session
rechecks and explicit close/recovery behavior. Never replay application mutations.

## Completed foundations

Examples #1–#7 established the shared API, browser and Flutter foreground CRUD apps,
opt-in scoped persistence, validated recovery, injectable Flutter lifecycle tests,
owned SDK status subscriptions, unknown-write outcome acceptance, private Compose
deployment and static HTTPS/CSP hosting. See compatibility.md, json-acceptance.md
and deployment.md for exact evidence and limitations.

## Open acceptance and deployment work

- Physical Android/iOS and real mobile-browser runtime matrices.
- Actual BFCache, storage/network transitions and live relay migration.
- Controlled authenticated relays, public DNS/ACME and durable artifact hosting.

SDK repository `locho` owns shared Rust/session/native code, SDK APIs, packages and
external consuming-app checks. This repository owns canonical contracts/backend,
full apps, persistence/lifecycle and deployment/application acceptance. Package
handoffs must include immutable run/source/version/checksum and reviewed compatibility
updates. Mocks aid deterministic race testing; packaged transport tests establish
runtime evidence. PRs remain reviewable slices and are merged by the user.
