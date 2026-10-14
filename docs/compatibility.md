# Compatibility baseline

| Component | Baseline / evidence |
| --- | --- |
| Node / npm | 24.18.0 / 11.16.0 on development macOS |
| TypeScript | 5.9.3, exact lockfile pins |
| API | v1; OpenAPI document 1.0.0; database schema 1 |
| Fastify / Argon2 | 5.12.7 / 0.45.1 |
| Locho host | v1.2.0 / `locho/3`; native adapter merged in PR #80 (`558d2e4`) |
| Flutter tooling available | Flutter 3.44.5 / Dart 3.12.2; Android NDK 28.2 |
| Flutter SDK artifact | Not yet available; FRB feasibility next |
| Browser SDK artifact | Not yet available; WASM/relay proof pending |
| Tickets | Draft v1; addressing freeze pending browser proof |
| Device support claims | None yet; physical Android validation scheduled, iOS open |

Backend baseline verified on development macOS: clean `npm ci`, type checking,
production build, all eight backend tests, OpenAPI/fixture validation, seed/reset,
compiled-server health and real Locho CLI TCP health/login/create/list smoke.

Record exact SDK artifact version/commit and installation method when either app
lands. Prerelease consumption must work outside the SDK checkout, including
transitive Rust source dependencies. Do not infer Flutter/browser support from
desktop Rust tests. Public-relay and physical-network evidence are separate from
controlled direct-address checks.
