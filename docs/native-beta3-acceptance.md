# Coordinated native beta.3 acceptance — 2026-10-26

## Scope and artifacts

This pass upgrades the host CLI and Flutter SDK while retaining browser beta.3.
It does not redesign authentication, upgrade Flutter/FRB/toolchains, expose the
private API, or change application retry/persistence policy. Notes API identity v1,
OpenAPI 1.2.0 and SQLite schema v2 remain unchanged.

All three published components record clean release source
`0c8ad57cc91af30144138bd324aeca86604f48dd`:

| Component | Version | Distribution / integrity |
| --- | --- | --- |
| CLI | `1.3.0-beta.3` | GitHub release; full source SHA pinned in CI and Compose |
| Browser | `locho_web@0.1.0-beta.3` | npm, unchanged lockfile integrity |
| Flutter | `locho_flutter@0.1.0-beta.3` | pub.dev, hosted archive checksum in pubspec.lock |

Verified Flutter archive SHA-256:
`fcdad92b61204ed6ef3ead00fb5f46ea780a7263ee3f4465226d5ecc05faa735`.
Its `BUILD.json` records the same clean source and native revision, wire protocol 3,
ticket format 1 and bundled-source distribution. FRB stays 2.12.0. Native Rust is
built by the consuming application; no private bindings or native archive downloads
are introduced.

Verified published macOS ARM64 CLI archive SHA-256:
`6d7f0ba14a273a60b28328bbe28f4cb656d3f77d8bb467cb015a27cbedb369d8`.
Executable SHA-256:
`454a02684a5442376b5a114e8df88355729667886378bb9a3c2b5c63d3aab8cd`.
It reports clean beta.3 at the release SHA. The existing beta.1 reference reports
clean `3786da3127338b2530e0cd8cea8ef23bc6d55dfd`.

The native releases include ctutils 0.4.4 for RUSTSEC-2026-0385, iroh 1.4.0 and
shared-peer/lifecycle hardening. Protocol/ticket compatibility is unchanged, but
the old-ticket migration result below is tested rather than inferred from version
labels. No stable release tags/installers are promoted. Public-N0 intermittency and
physical-device limitations are not declared solved.

## Existing-ticket host upgrade and rollback

```sh
npm ci
npm run build
npx playwright install chromium
LOCHO_PREVIOUS_BINARY=/absolute/path/to/beta.1/locho \
LOCHO_BINARY=/absolute/path/to/beta.3/locho npm run smoke:host-upgrade
```

The probe creates an isolated notes API, users, host identity, service configuration
and **one original beta.1 ticket**. A production cookie-mode browser creates a note,
forgets its client and drains event ownership. The fixture then replaces only the
host executable: beta.1 → beta.3 → beta.1. It never re-shares or regenerates the
ticket, clears host state, or replaces the live database/configuration. Each new
pairing/login uses the original ticket. Notes remain present and exactly one edit
is committed after upgrade; mutation counts are 1 → 2 → 2 with no write replay.

The probe explicitly re-pairs between executable swaps; it is not proof of seamless
continuous streaming through an upgrade. Ordinary host-restart recovery remains
covered by the browser/native failure suites. It touches only disposable state,
not a real deployment. Keep identity/database backups before upgrading deployed hosts.

The Node-only `replaceHost` fixture method is not exposed through the HTTP control
API. Current CLI smoke and host migration are CI gates; the previous CLI checkout
is isolated from the current binary and exists only for this migration probe.

## Android runtime versus builds

The existing Linux/macOS matrix continues to run formatting, analysis, unit tests,
Android ARM64/x86_64 debug/release builds and iOS simulator/unsigned release builds.
Those compilation checks do not establish native runtime/network behavior.

The new `android-runtime` job uses an API 36 x86_64 emulator and the pinned beta.3
host. It builds production web assets and runs, sequentially:

```sh
node scripts/flutter-fixture.mjs
node scripts/flutter-fixture.mjs --ui
node scripts/flutter-fixture.mjs --failures
node scripts/flutter-fixture.mjs --events
node scripts/flutter-fixture.mjs --release
node scripts/flutter-fixture.mjs --process-restart
```

These cover controller and tap-driven CRUD, secure restoration, lifecycle,
host restart/upstream outage, committed-but-lost POST/PATCH/DELETE responses,
cookie-browser ↔ bearer-Flutter bidirectional events, isolation, expiry/logout,
65 seconds of real 30-second heartbeats, missed-change recovery, draft preservation,
release execution and real force-stop/relaunch restoration. This is foreground-only.

The runner selects `android-arm64` or `android-x64` release builds from the selected
device's actual ABI. CI reports ABI/API/page size; x86_64 CI is not ARM64/16 KiB
evidence. The local owned emulator is separately identified below. The runner removes
its reverse-port mapping and force-stops only `dev.chop.locho_notes` on exit. The
process-restart test clears this disposable app's storage explicitly.

Run only on disposable emulators/test accounts. Tickets and dart-defines stay in
mode-0600 temporary files. Test APKs embed disposable tickets: do not upload APKs,
define files, traces, screenshots/videos, databases or raw device logs as artifacts.
Only fixed stage markers and allowlisted platform/result metadata are diagnostics.
Application writes and state-changing fixture commands are never retried; the
existing bounded retry applies only to Playwright's read-only fixture status query.

## Execution record

### Host-first checks, before upgrading Flutter

- Published beta.3 CLI version/checksum/provenance verified.
- `npm run check`: passed (17 API + 35 browser unit/controller/configuration tests).
- `npm run smoke:locho`: direct TCP health/login/notes/incremental SSE passed.
- `npm run smoke:host-upgrade`: original ticket, identity/config and notes survived
  both executable swaps; no mutation replay.
- Full beta.3-host Chromium/Firefox/WebKit matrix: **55 passed / 5 expected skips**
  (6.0 minutes). Browser SDK unchanged; the Flutter SDK pin was not needed by these
  browser cases. Expected skips remain three deployment-only and two non-Chromium
  actual worker-termination cases.

### Flutter beta.3 local checks

- pub.dev archive checksum and clean bundled/native provenance verified. Only the
  direct SDK dependency/lock entry changed; other package/toolchain pins are retained.
- Flutter analysis and all **29 unit/widget tests** passed, including the new
  small-viewport acceptance-helper regression.
- Android **ARM64 + x86_64 debug and release APK builds** passed locally. This
  cross-build result is separate from x86_64 emulator execution in CI.
- Disposable Pixel 6 emulator, image `android-37.1/google_apis_playstore_ps16k`,
  emulator 36.6.11, reported API 37, ABI `arm64-v8a`, **PAGE_SIZE=16384**. This is
  an owned, separately created AVD; the pre-existing user's AVD was not used/reset.
- Basic real native pairing/CRUD/restoration/lifecycle/logout acceptance passed.
- Initial tap-driven acceptance exposed a lazy-ListView helper bug on the smaller
  viewport: `Delete` had not been built when `ensureVisible` resolved its element.
  Helpers now hide the keyboard, scroll/build the target and then interact, with
  an independent lazy-list widget regression. The corrected tap-driven journey passed;
  the initial failed UI run is not counted as acceptance.
- **All six ARM64/16 KiB runtime journeys passed:** basic controller acceptance,
  tap-driven UI, fault/host-restart handling, cookie-browser interoperability,
  autonomous release execution and real Android process-restart restoration.
- Event interoperability completed in 1m44s, including 65 seconds across two real
  30-second heartbeats, bidirectional CRUD, isolation, missed-change refresh, draft
  preservation, suspend/resume, logout and expiry. `NOTES_CROSS_PLATFORM_EVENTS_PASS`
  was observed; the browser peer used cookie mode and Flutter used bearer sessions.
- Release APK execution and `NOTES_RESTART_SEEDED` → new PID → `NOTES_RESTART_PASS`
  completed with beta.3 native code. These are debug-signed test APKs with synthetic
  credentials, not distributable application releases.
- Credential-removal assertions check booleans rather than printing a surviving
  ticket/token as an assertion's actual value on failure.

### Hosted baseline and outstanding gates

PR #15 merged at `45ea7b6dc5c6da4383faa878fa1da9341fcd8ccf` with green main-branch
[browser](https://github.com/trchopan/locho_sdk_examples/actions/runs/40202846912),
[Compose/Caddy HTTPS](https://github.com/trchopan/locho_sdk_examples/actions/runs/40202846954)
and [Flutter build](https://github.com/trchopan/locho_sdk_examples/actions/runs/40202846911)
workflows. That was the **old host/Flutter beta.1 baseline**, not acceptance of this
new native combination and not Android runtime CI.

The new host/Flutter build, deployment and Android x86_64 runtime CI must pass for
this PR. Local Docker is unavailable; full Xcode/CocoaPods are unavailable, so local
Compose/iOS results are not claimed. Physical Android/iOS, physical/mobile browsers,
actual BFCache, broad network transitions and public DNS/ACME remain separate gates.
Do not equate unsigned iOS compilation or debug-signed acceptance APKs with store
releases or physical-device support. The existing transitive npm `fast-uri` advisory
is outside this native upgrade and is not silently fixed by changing SDK versions.
