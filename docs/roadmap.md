# Development roadmap and handoffs

## Current slice: coordinated native beta.3 acceptance

Host CLI 1.3.0-beta.3 and Flutter SDK 0.1.0-beta.3 now align with the unchanged
browser beta.3 release at `0c8ad57cc91af30144138bd324aeca86604f48dd`. This is one
coordinated PR, with host-only verification performed before changing the Flutter
pin. CI/Compose pin the current host SHA; a separate beta.1 build exists only for
the existing-ticket upgrade/rollback probe. No stable installer/channel is changed.

Android CI now has a real x86_64 emulator runtime job in addition to the existing
Android/iOS build matrix. Cookie-browser/native event interoperability, restoration,
faults and release/process restart are tested, not inferred from compilation. Local
ARM64/16 KiB evidence is separate from x86_64 CI and physical-device support. See
[native beta.3 acceptance](native-beta3-acceptance.md) for exact outcomes/gates.

## Completed browser-only sequence — PR #15

The notes app now defaults to a module-worker, memory-only cookie session, with
explicit legacy bearer mode and unchanged Flutter routes. OpenAPI 1.2.0 adds the
browser namespace; schema v2 separates authentication transports. See
[cookie-session design, evidence and remaining gates](cookie-sessions.md).
The browser now pins published `locho_web@0.1.0-beta.3`; the temporary package archive
and Docker copy step are removed. Local registry acceptance passes all 55 active
Chromium/Firefox/WebKit cases with five expected skips, including the four prior
Firefox restore/re-pair failures. No whole-test retries or application-write replay were
enabled. Hosted browser, Flutter build and Compose/HTTPS CI subsequently passed on
the merged baseline. That build-only Flutter matrix did not establish Android runtime
interoperability with the cookie browser.
Earlier milestones below describe the previous registry baseline.

The first sequence—browser SDK migration and local cookie-session acceptance—is
complete. It deliberately retained host CLI `1.3.0-beta.1` and Flutter SDK
`0.1.0-beta.1`; the current native upgrade above is a separate compatibility result.

## Earlier milestone: registry beta.1 acceptance

Both apps pin public `0.1.0-beta.1` SDKs and install through npm/pub.dev with
committed lockfiles. Archive download/bootstrap steps have been removed from setup,
CI and Docker. Restore persistence/401 fixes and the latest green browser matrix are
recorded in registry-acceptance.md, alongside historical unexplained timeouts.

## Live note updates

- Backend authenticated `/api/events` and OpenAPI 1.1.0 merged in examples #8:
  scoped committed invalidations, bounded subscribers/backpressure, heartbeat,
  logout/expiry checks and no replay.
- Browser streaming transport merged in Locho #98: bounded pull-driven response
  bodies and setup/idle deadlines, now distributed in the npm beta.
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
Flutter uses the pub.dev beta; no new native streaming API is required. See events.md.

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
- Controlled authenticated relays and public DNS/ACME.
- Browser restore/initial-health timeouts over public N0; see registry-acceptance.md.

SDK repository `locho` owns shared Rust/session/native code, SDK APIs, packages and
external consuming-app checks. This repository owns canonical contracts/backend,
full apps, persistence/lifecycle and deployment/application acceptance. Package
handoffs must include immutable run/source/version/checksum and reviewed compatibility
updates. Mocks aid deterministic race testing; packaged transport tests establish
runtime evidence. PRs remain reviewable slices and are merged by the user.
