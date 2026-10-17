# Registry SDK acceptance — 2026-10-17

## Candidate host rerun — `1.3.0-beta.1`

Examples CI and private Compose now build Locho merge
`3786da3127338b2530e0cd8cea8ef23bc6d55dfd`, reporting
`locho 1.3.0-beta.1` with clean provenance. The registry SDK pins and checksums
are unchanged.

- API/contract checks, production build and 12 API / 21 browser unit tests passed.
- Candidate binary real TCP health/login/notes/incremental-SSE smoke passed.
- The full local browser run had 34/36 active tests pass on its first public-N0
  attempt; the two initial Chromium/Firefox health/restore failures passed focused
  reruns. Three deployment-only cases were skipped in this mode.
- Candidate-pinned private Compose and Caddy internal-CA HTTPS/CSP/WASM acceptance
  passed all 6 Chromium/Firefox/WebKit cases.
- Flutter `pub get --enforce-lockfile`, formatting, analyze, 28 unit/widget tests,
  and Android ARM64/x86_64 debug/release builds passed. No Android emulator was
  attached for this rerun; emulator/physical runtime evidence remains separate.
- The Docker candidate build fetched and verified the exact full merge SHA.

This rerun confirms the final host revision is compatible with the published SDK
betas and examples. Public-N0 intermittent readiness/restore behavior remains an
environment-dependent limitation, not a candidate-specific regression.

## Package pins and installation

- Browser: `locho_web` **0.1.0-beta.1** from npm. Root package-lock.json pins
  `https://registry.npmjs.org/locho_web/-/locho_web-0.1.0-beta.1.tgz` and integrity
  `sha512-q5utHDCCFIegS9yFrW8mVO5rEsAOwteyrqex9xcpGRsny/gMBq+4lwtrESBhPfkbZjaSiAiTNwQ7Oh6R43fI2g==`.
- Flutter: `locho_flutter` **0.1.0-beta.1** from pub.dev. apps/flutter/pubspec.lock
  pins archive SHA-256
  `40d69471f0a0fe99bf19788eb260e428d30fc1124c4cfdede6bbef6172eb0234`.
- The Flutter package bundles matching Locho core/native Rust sources and generated
  bindings. Rust/native platform toolchains remain required.
- A fresh temporary copy of tracked files, with neither vendor nor dependency/build
  directories, passes `npm ci`, `npm run check`, and Flutter locked install,
  analysis and all 28 tests. Public package-manager caches may be reused; this is
  fresh-checkout acceptance, not a claim of empty global caches or offline builds.

## Results

| Check | Result |
| --- | --- |
| TypeScript checks and API/web production build | Passed |
| Backend tests / browser unit tests | 12 / 21 passed after restore fixes |
| OpenAPI and fixture validation | Passed |
| Real CLI TCP health/login/CRUD/incremental SSE smoke | Passed |
| Full production Chromium/Firefox/WebKit matrix | Latest normal run: 36 passed, 3 deployment-only skips; historical timeouts below |
| Private Compose browser journey | All 3 browsers passed |
| Caddy HTTPS/CSP/WASM journey | All 3 browsers passed; test-only internal CA |
| Flutter formatting/analyze/unit-widget checks | Passed; 28 tests |
| Android ARM64/x86_64 debug/release APKs | Passed |
| Release APK 16 KiB ELF LOAD / ZIP alignment | Passed, 8 native libraries |
| Android debug controller journey / tap-driven UI | Both passed |
| Host restart / stopped upstream / unknown writes, no replay | Passed |
| Autonomous release journey | Passed |
| Release force-stop/relaunch remembered-session restore | Passed |
| Browser↔Flutter events, isolation, recovery and 65s heartbeat stability | Passed |
| iOS builds / physical devices / real mobile browsers | Not rerun locally; full Xcode unavailable |

Local toolchain: Node 24.18.0/npm 11.16.0, Flutter 3.44.5/Dart 3.12.2,
Android NDK 28.2.13676358, Docker Engine 29.6.1. Runtime device: emulator-5554,
Android 17/API 37, arm64-v8a, 16384-byte pages. Local host binary reports Locho
1.2.0, clean commit `52d903e612aaca6d88b780c92e3fe72d76fa693a`.
Earlier Compose/CI acceptance used host source `4f8aa20c3bcbabb667ef2354510bdb101d690fa6`.
The current candidate handoff pins Compose/CI to Locho `1.3.0-beta.1`, merge
`3786da3127338b2530e0cd8cea8ef23bc6d55dfd`; candidate rerun results are recorded
below and in the branch CI.
These results are local evidence; hosted CI verifies the migration separately.

Android packaging explicitly restricts native ABIs to ARM64/x86_64 and excludes
transitive 32-bit JNI assets. Without the packaging exclusion, a transitive AAR
added armeabi-v7a/libdartjni.so despite Flutter's requested target platforms.

## Browser investigation and restore fixes

Follow-up investigation added opt-in fixture health receipt/response-finish counters
and sanitized boundary messages (`LOCHO_DIAGNOSTICS=1`). Before changing application
behavior, six expiry runs, nine restore/resume cases and a full instrumented matrix
passed (36 passed, three deployment-only skips). Thus disappearance of the historical
timeout cannot be attributed to the subsequent fixes.

Two independently confirmed application issues were corrected:

1. Expiry previously exposed login before saved-token removal finished. Private
   user/notes are now cleared immediately, but login is published after persistence
   settles. The real-browser test asserts the persisted record has pairing and no
   auth before reloading. A delayed-storage unit test covers this ordering.
2. Restoring an invalid saved token previously cleared auth correctly, then replaced
   the login state with disconnected. A `/api/me` 401 now leaves the healthy client
   available for login and retains normal status observation.

Verification after these fixes: `npm run check` passes (12 API/21 browser unit
tests), 12 repeated Firefox expiry/restore/resume/revoked-token cases pass, the
normal non-diagnostic full matrix passes all 36 active cases, and all six private
Compose/HTTPS deployment cases pass. Two relay-hinted Firefox cases and a direct-API
remembered-login case also pass. No SDK patch, retry of application requests, or
longer request deadline was introduced.

The original generic timeout remains unexplained, not a demonstrated fixed SDK
defect. SDK `timeout` conflates acquisition/service authorization and the HTTP
operation deadline; peer connection alone does not establish upstream receipt.
If it recurs, capture boundary counts plus SDK stage diagnostics before deciding
whether transport, handshake, or response parsing is responsible. Controlled-relay
reproduction and per-stage WASM diagnostics remain follow-up work.

### Historical failing evidence

The full suite is not unconditionally green. First run: Firefox page suspension
and remembered-login restoration fail, then both pass a focused rerun. Second run:
Chromium initial pairing in the remembered-logout case and Firefox expiry reload
fail. Chromium passes a focused rerun. Firefox expiry reload fails two further
focused reruns; a temporary sanitized diagnostic confirms peer connection completes
but buffered `/health` fails with SDK `timeout` while the app is `checking`.
The app displays a disconnected error and retains pairing; it does not invent an
authentication failure or replay a write. Temporary diagnostics were removed.

These tests use public N0 discovery/relays. Do not classify the historical failures
conclusively as an N0 outage. The latest matrix is green, but that result does not
establish the cause of the earlier transport timeout.

## Reproduce

From the repository root:

```sh
npm ci
npm run check
LOCHO_BINARY=/path/to/locho npm run smoke:locho
LOCHO_BINARY=/path/to/locho npm run test:browser
npm run test:deployment
LOCHO_BINARY=/path/to/locho npx playwright test --project firefox --grep 'idle session expiry clears'
# Boundary evidence, retaining default discovery-only tickets and fault proxy:
LOCHO_DIAGNOSTICS=1 LOCHO_BINARY=/path/to/locho npx playwright test --project firefox --grep 'idle session expiry clears'
# Compare a relay-readiness wait plus explicit hint (not a production default):
LOCHO_FIXTURE_RELAY_HINT=1 LOCHO_BINARY=/path/to/locho npx playwright test --project firefox --grep 'idle session expiry clears'
# Compare without fault proxy; select only scenarios that do not require its controls:
LOCHO_FIXTURE_DIRECT_API=1 LOCHO_BINARY=/path/to/locho npx playwright test --project firefox --grep 'remembered login restores'
```

From apps/flutter:

```sh
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze
flutter test
flutter build apk --debug --target-platform android-arm64,android-x64
flutter build apk --release --target-platform android-arm64,android-x64
```

With a disposable Android emulator available, from the repository root run
`LOCHO_BINARY=/path/to/locho node scripts/flutter-fixture.mjs` with each of:
no flag, `--ui`, `--failures`, `--release`, `--process-restart`, and `--events`.
The process-restart mode resets only the disposable demo app's local storage.
Fixtures clean up their own temporary host/API/browser resources and adb reverse
mappings. Public relay connectivity remains a network-dependent input.
The relay-hint comparison makes bounded diagnostic readiness attempts before creating
the ticket; it never retries application writes. Direct-API mode bypasses fault and
event-stream counting controls and is unsuitable for the full failure/events suite.
