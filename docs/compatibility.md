# Compatibility baseline

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
| Locho host | v1.2.0 / `locho/3`; native adapter merged in PR #80 (`558d2e4`) |
| Flutter tooling available | Flutter 3.44.5 / Dart 3.12.2; Android NDK 28.2 |
| Flutter SDK artifact | locho_flutter 0.1.0-dev.2, run 38877468589, SHA-256 be944a6e24d5df8c55b6d3a142bbe11c78b16d8ceace9a9e3463736b19a22cad; native source 4f8aa20 |
| Browser SDK artifact | @locho/web 0.1.0-dev.3, Locho PR #98 source e5faa3f320c9c142dbc155ac8e4a27e01a0c0d7f, CI test-merge 8a9e67e3fbe978a1f62ff1782ba7b183af568b7f, run 38932541782; SHA-256 83ea65e191af93a40cc1b652642e4335ef044ebb39fa31b64488ef736d5e091c |
| Tickets | v1 locho1: format, shared Rust/WASM/FRB codec; CLI --ticket |
| Device support claims | None yet; physical Android validation scheduled, iOS open |

Browser app now passes the memory-only production UI journey on local Chromium,
Firefox and WebKit through public N0 using the pinned SDK tarball. Host CI builds
the same 4f8aa20 revision. Flutter SDK source archives/external Android/iOS builds
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
from Locho PR #97 successful immutable CI runs; no registry publication is assumed.

Backend baseline verified on development macOS: clean `npm ci`, type checking,
production build, all eight backend tests, OpenAPI/fixture validation, seed/reset,
compiled-server health and real Locho CLI TCP health/login/create/list smoke.

Record exact SDK artifact version/commit and installation method when either app
lands. Prerelease consumption must work outside the SDK checkout, including
transitive Rust source dependencies. Do not infer Flutter/browser support from
desktop Rust tests. Public-relay and physical-network evidence are separate from
controlled direct-address checks.
