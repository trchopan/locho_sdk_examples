# JSON failure acceptance — 2026-10-16

The original JSON acceptance used dev.2 SDKs, followed by browser dev.3 live events.
Both apps now consume published 0.1.0-beta.1 SDKs. See compatibility.md for exact
pins and registry-acceptance.md for the current rerun results and browser blocker.
The shared test-only `scripts/acceptance-fixture.mjs` starts an isolated reference
API, disposable users, a numeric-loopback forwarding boundary and the real Locho
host. It generates a fresh ticket, exposes fixture control only on host loopback,
and cleans up processes, sockets and temporary state.

The forwarding boundary is fault injection for tests, not an application gateway
or production deployment. It pipes requests to the actual API without storing
headers/bodies. On command it discards one successful mutation response after the
backend finishes, simulating an unknown application outcome. Counts contain no
credentials or user data. Fixture control is not exposed in either production app.

## Results

| Scenario | Browser production UI | Flutter Android emulator |
| --- | --- | --- |
| Host stop/restart, same identity and capability | Passed on Chromium/Firefox/WebKit | Passed real controller/runtime integration |
| Stopped upstream and fresh request after restoration | Passed | Passed |
| POST/PATCH/DELETE commit then response loss | Unknown outcome shown; explicit refresh confirms each result | Same controller/runtime checks |
| No mutation replay | Exactly three backend mutations and three discarded responses | Same counters verified |
| Remembered owner replacement | Close page, new page in same browser context restores health/me/notes | Force-stop/relaunch release app with different PID restores secure session |
| Tap-driven pair/login/create/edit/delete/logout/forget | Existing UI suite | Passed against actual widgets and real SDK/API |

Browser suite: **27 production UI tests pass locally** across Chromium, Firefox and
WebKit. Android evidence: emulator-5554, ARM64 Android 17/API 37, 16384-byte memory
pages. Flutter analysis and all 20 deterministic/widget tests still pass.

Host restart may reconnect the peer before fresh API validation succeeds. If the
application reports validation failure, tests use its explicit Reconnect action
without re-pairing or logging in. They never resubmit the interrupted mutation.
Public N0 discovery/relay availability remains a network-dependent test input.

## Reproduce

Build/install dependencies and the API/web production output using the root README.
Provide a ticket-capable CLI binary through LOCHO_BINARY:

```sh
LOCHO_BINARY=/path/to/locho npm run test:browser
LOCHO_BINARY=/path/to/locho node scripts/flutter-fixture.mjs --ui
LOCHO_BINARY=/path/to/locho node scripts/flutter-fixture.mjs --failures
LOCHO_BINARY=/path/to/locho node scripts/flutter-fixture.mjs --process-restart
```

`LOCHO_DEVICE` defaults to emulator-5554. Failure-mode control reaches host loopback
through a temporary adb reverse mapping, removed in cleanup. `--process-restart`
builds the dedicated synthetic release entry point, clears **only the disposable
dev.chop.locho_notes app** before seeding, checks its fixed seed marker, force-stops
and relaunches without rebuilding/reinstalling, verifies the PID changed and awaits
the restore/delete pass marker. This resets that demo app's local credentials; do
not run it against an installation whose pairing you intend to retain.

The normal `--release` controller journey and original debug journey remain usable.
Screenshots/traces/videos are not collected, and fixture ticket input is written
only to a temporary mode-0600 defines file.

## Evidence boundaries

- Browser new-page testing is not an actual full browser-process restart or proof
  of BFCache entry. Android force-stop testing is a real app-process replacement,
  but does not establish OS termination/backup/uninstall or physical-device behavior.
- Flutter tap-driven coverage establishes the basic journey, not every error/UI race.
  Failure injection uses the real app controller but is not tap-driven throughout.
- Browser tests run in CI; Flutter emulator modes are manual acceptance commands.
  Hosted Android/iOS compilation does not imply emulator/device runtime acceptance.
- Physical iOS/Android notes acceptance, mobile browser, real network transitions,
  selected transport-path evidence, storage lock/unlock and HTTPS/private-container
  deployment remain separate gates. Controlled relay tests, SSE and WebSockets are
  not completed by this slice.
