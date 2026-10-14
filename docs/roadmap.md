# Next development and handoffs

SDK team owns `locho`: Rust core/native adapter, Flutter/browser packages, tiny
smoke apps, package/runtime checks. Samples team owns this repository: canonical
OpenAPI, one backend, full apps, storage/lifecycle and deployment/application tests.

| Slice | Repository | Exit |
| --- | --- | --- |
| 1 — current | examples | Tested auth/notes API, schemas/fixtures, seed/reset and native Locho setup |
| 2 | locho | Android-first FRB package: real Android attach/GET/close, iOS compilation CI |
| 3 | locho | Browser WASM/discovery/relay proof against this same API |
| 4 | locho | Addressing decisions frozen; CLI tickets and shared Rust/Dart/TS vectors |
| 5a/5b | locho | Distributable Flutter/browser packages and external-consumer builds |
| 6a | examples/apps/flutter | Foreground pair/health/login/notes/remember/restore, device evidence |
| 6b | examples/apps/web | HTTPS pair/health/login/notes/remember/restore, browser matrix |
| 7 | both | Authenticated incremental SSE, then bidirectional WebSockets |

Scaffold the full apps only when their dependency slice begins. Node and Flutter
retain independent builds/locks. Backend work can overlap SDK feasibility; mocks
support UI iteration but are not acceptance evidence. Native container deployment
and CI for this repository follow initial local review/GitHub setup.

Package handoffs include artifact/version/commit, exact install/build commands,
public types, supported target matrix, safe error examples and known limitations.
This repository returns versioned backend fixtures and sanitized integration
reproductions. Update `docs/compatibility.md` deliberately on upgrades.

Later SSE `/api/events`: per-user note-change invalidation, 30-second heartbeat,
bounded queues and session rechecks. No durable replay; refresh notes after recovery.
Later WebSocket `/api/ws`: bearer upgrade auth, ping/pong demo, bounded messages,
session rechecks and application expiry close code 4001. These do not block JSON.
