# Compatibility baseline

## Registry beta migration — 2026-10-17

Both apps now pin published `0.1.0-beta.1` SDKs. Install with `npm ci` at the
repository root and `flutter pub get` in `apps/flutter`. Lockfiles record registry
URLs and integrity; no vendor archives or GitHub credentials are required.
The Flutter package bundles matching native/core Rust sources from base revision
`cb1b232` with release preparation changes, rather than fetching separate Git sources.
See [registry acceptance](registry-acceptance.md) for the migration verification.

## CLI beta handoff — 2026-10-17

The examples' CI and private Compose host now pin Locho CLI candidate
`1.3.0-beta.1` at full merge commit
`3786da3127338b2530e0cd8cea8ef23bc6d55dfd`. The SDKs remain independently pinned
to browser `locho_web` `0.1.0-beta.1` and Flutter `locho_flutter` `0.1.0-beta.1`.
Candidate-specific API, browser, Compose/HTTPS and Android acceptance is run from
this branch before the CLI tag is published. The public SDK registry checksums are
unchanged.

## Earlier acceptance

Flutter live events now interoperate with the production browser app using the
existing dev.2/dev.3 pins: bidirectional CRUD/recovery and 65s heartbeat stability
pass on Android API 37 ARM64 16 KiB emulator + Chromium. Flutter has 28 unit/widget
tests; see events.md and apps/flutter/README.md for runtime reproduction/limits.

JSON failure acceptance now adds a 27-case local browser matrix and Flutter
tap-driven CRUD, host/upstream faults and release process-restart restore on the
Android ARM64 16 KiB emulator. See json-acceptance.md; these results do not establish
physical iOS/mobile-browser or real network-transition acceptance.

| Component | Baseline / evidence |
| --- | --- |
| Node / npm | 24.18.0 / 11.16.0 on development macOS |
| TypeScript | 5.9.3, exact lockfile pins |
| API | v1; OpenAPI document 1.1.0; database schema 1 |
| Fastify / Argon2 | 5.12.7 / 0.45.1 |
| Locho host | v1.3.0-beta.1 / `locho/3`; merge `3786da3`; candidate acceptance in this branch |
| Flutter tooling available | Flutter 3.44.5 / Dart 3.12.2; Android NDK 28.2 |
| Flutter SDK | locho_flutter 0.1.0-beta.1 from pub.dev; SHA-256 40d69471f0a0fe99bf19788eb260e428d30fc1124c4cfdede6bbef6172eb0234 |
| Browser SDK | locho_web 0.1.0-beta.1 from npm; SHA-512 integrity recorded in package-lock.json |
| Tickets | v1 locho1: format, shared Rust/WASM/FRB codec; CLI --ticket |
| Device support claims | None yet; physical Android validation scheduled, iOS open |

Browser app now passes the memory-only production UI journey on local Chromium,
Firefox and WebKit through public N0 using the pinned SDK tarball. Host CI builds
the candidate `3786da3` revision. Flutter SDK source archives/external Android/iOS builds
exist in Locho PR #95; the standalone Flutter notes application is implemented in
examples PR #3 with hosted Android/iOS builds and Android emulator runtime evidence.
Opt-in IndexedDB sessions and page-event restoration now pass the 18-case local
browser matrix; 11 controller tests exercise storage/recovery races and policy.
Flutter notes debug/release runtime acceptance passes on Android 17/API 37 ARM64
16 KiB emulator: real ticket/API, secure-storage restore, CRUD/isolation and lifecycle.
External iOS app compilation is checked by CI, not physical runtime acceptance.
Physical mobile/HTTPS deployment, actual BFCache entry and real network-transition
acceptance remain open. Dev.2 adds owned browser watch subscriptions instead of
polling and bounded Flutter unsubscribe independent of client close. Packages come
from Locho PR #97 immutable CI runs in this earlier evidence. Current registry pins
and rerun results are recorded above and in registry-acceptance.md.

Backend baseline verified on development macOS: clean `npm ci`, type checking,
production build, all eight backend tests, OpenAPI/fixture validation, seed/reset,
compiled-server health and real Locho CLI TCP health/login/create/list smoke.

Record exact SDK artifact version/commit and installation method when either app
lands. Prerelease consumption must work outside the SDK checkout, including
transitive Rust source dependencies. Do not infer Flutter/browser support from
desktop Rust tests. Public-relay and physical-network evidence are separate from
controlled direct-address checks.
