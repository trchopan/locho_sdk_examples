# Flutter notes application

## Live note events

Authenticated foreground sessions subscribe to `/api/events` through ordinary
streamed Dart HTTP over the packaged SDK's loopback attachment. The Flutter SDK
is pinned to pub.dev `0.1.0-beta.1`; events use ordinary Dart streamed HTTP.

- A dedicated event HTTP client avoids cancelling concurrent JSON requests.
- Subscribe before initial/recovery canonical list refresh. One list read runs at
  a time; bursts mark one dirty follow-up. Event refresh defers during user actions.
- Incremental strict UTF-8 and CR/LF/CRLF SSE parsing handles comments/multiline
  data, ignores unknown event names/id/retry, and validates NoteChange fields.
  The parser bounds each line/event to 4096 bytes, including repeated fields.
- Setup deadline 15s; per-read idle deadline 75s, with no whole-stream deadline.
  EOF/reset/timeout/malformed data enters capped jittered backoff (1s initial,
  30s cap; stable 30s resets it). 429 respects integer Retry-After up to 300s.
- Recovery validates health/me, subscribes, then refreshes missed changes; no
  Last-Event-ID or mutation replay. Live status is separate from transport/auth.
- Drafts and unknown-write messages survive event refresh. Session expiry clears
  token/saved auth and rejects stale in-flight authenticated results.
- Background/disconnect/logout/forget/scope switch/dispose abort the event request,
  close its HTTP client and cancel retry timers. Resume requires surviving intent.
  Final close gives event cleanup the configured 15s cleanup budget.

`SessionDependencies.eventClient` injects dedicated streaming clients for tests;
production configures it explicitly. Null supports existing JSON-only fake transports.

### Cross-platform reproduction

From repository root, after `npm ci`, `npm run build`, `flutter pub get` inside
`apps/flutter` and booting the disposable Android emulator:

```sh
LOCHO_BINARY=/absolute/path/to/locho node scripts/flutter-fixture.mjs --events
```

This starts the production packaged browser app in Chromium and runs Flutter's
integration test on `LOCHO_DEVICE` (default emulator-5554) against the same private
API/Locho host. Temporary credentials remain in mode-0600 defines and browser memory;
no traces/screenshots/video are captured. The test control bridge drives browser UI
and fixture faults only; app notes/auth traffic still uses the actual SDK transports.
Fixture closes browser, HTTP controls, host and adb reverse on completion.

Local Android 17/API 37 ARM64 **16384-byte-page emulator** verification passes:
browser↔Flutter create/update/delete, user isolation, 65s stable streams spanning
two production 30s heartbeats and the old buffered deadline, missed changes during
event outage, draft retention, suspension/resume, session-specific logout and idle
expiry removing secure-storage token. Eight new deterministic tests cover framing,
limits, late admission, idle deadline, coalescing, retry/429 and stale auth races
(28 Flutter unit/widget tests total). Existing real host/upstream/interrupted-write
acceptance and autonomous release acceptance also pass with live events enabled.
These runtime results are emulator/Chromium evidence; CI checks Android/iOS builds,
not physical iOS/Android or a complete mobile-browser matrix.

## Status subscription ownership

The pinned SDK includes bounded status unsubscribe. App teardown
awaits subscription cancellation before client close, with the same cleanup budgets;
it no longer depends on owner close to unblock the status generator. Deterministic
tests and Android debug/release acceptance pass with this order.

## Reliability hardening — 2026-10-16

The controller now uses injectable ticket/client/attachment/HTTP dependencies,
with a separate production adapter for the pinned SDK. Deterministic tests cover
late parse/create/attach/health/login results, restore-vs-pair, save-vs-forget,
remember-off/deletion retry, repeated resume, terminal status, cleanup budgets,
token scoping and note-editor clearing. HTTP requests including logout explicitly
disable redirects. Logout invalidates pending work and removes local auth before
the bounded revocation attempt. Storage updates show progress and failure/retry.

Screens clear editor/password data on attachment/user invalidation and call shared
async session close on disposal. Close suppresses late notifications/new starts,
closes app HTTP clients and waits boundedly for SDK client/subscription cleanup.
Default cleanup waits are at most 15 seconds each for client and subscription;
pending storage completion is awaited for at most another 15 seconds on final close.
Timeout does not forcibly stop an OS storage transaction or an uncooperative Future;
generation/revision guards still discard obsolete results. The production SDK has
its own startup/cleanup bounds. Physical suspension can halt all execution.

Android debug/release notes acceptance was rerun successfully on the ARM64 emulator
after this refactor. These checks add reliability evidence, not physical-device,
network-transition, backup/uninstall or complete tap-driven UI acceptance.

Standalone Android/iOS foreground notes app using published `locho_flutter`
and the same API v1 as `apps/web`. No generated FRB imports or sibling
SDK Rust sources are required. This is a demonstration, not a background service.

## Setup

SDK pin: [`locho_flutter` 0.1.0-beta.3](https://pub.dev/packages/locho_flutter/versions/0.1.0-beta.3).
The committed `pubspec.lock` pins the hosted package and archive checksum. The SDK
bundles matching Locho Rust core/native sources and generated FRB bindings. Install
directly from pub.dev; no vendor bootstrap, GitHub login or SDK checkout is required.
Its clean bundled/native source revision is `0c8ad57cc91af30144138bd324aeca86604f48dd`;
FRB remains 2.12.0, wire protocol 3 and ticket format 1. See
[native beta.3 acceptance](../../../docs/native-beta3-acceptance.md) for current results
and the distinction from older evidence in this document.

From `apps/flutter`:

```sh
flutter pub get
flutter analyze
flutter test
flutter run -d emulator-5554
```

Use Flutter 3.44.5/Dart 3.12.2, Rust 1.96+, JDK 21 recommended, Android SDK 36+ and
NDK 28.2.13676358. Minimum Android API 23. Cargokit builds the bundled Rust sources
with `--locked`; cold builds need registry/toolchain network access. iOS needs
full Xcode/CocoaPods; run `flutter config --no-enable-swift-package-manager` first.
The iOS runner includes a local-network usage description and keychain entitlements;
device signing/provisioning remains developer configuration.

Run the reference API/seed and Locho host from the root README. Generate a TCP
ticket with `locho share sample-api --config deploy/locho.toml --ticket`, paste it,
then log in using the disposable fixture users. Never use deployed passwords in
committed files. The frontend build requires no React/browser build.

## Behavior and storage

- Pair → validate API identity/version → login → notes list/create/edit/delete.
- One client/attachment/HTTP owner per foreground session. Generation guards close
  obsolete starts and discard stale responses. Request deadline 15 seconds; streamed
  response buffering is capped at 8 MiB before JSON parsing. No mutation replay.
- Transport, API readiness and login are separate. A mobile TCP close cannot prove
  an invalid capability. HTTP errors use safe status messages. Interrupted writes
  show unknown outcome with explicit refresh; passwords/tickets are obscured and
  cleared from input on submission.
- Remember is disabled by default. Enabled storage uses `flutter_secure_storage`
  10.0.0 (Android Keystore-backed encryption / iOS Keychain), one versioned record
  with full host/service/type scope. Store ticket/token, never passwords or notes.
  Record writes/deletes are serialized; forgetting invalidates queued saves.
- Remember off deletes the saved record while keeping the live session. Forget
  removes local pairing/token but does not revoke server sessions. Logout removes
  the local token immediately and attempts bounded revocation; offline failure is
  explicitly unconfirmed. Authenticated 401 clears the token, keeping pairing.
- Restore validates `/health` and `/api/me` before authenticated notes. Changing
  host/service clears the previous token; same-scope capability replacement still
  requires session validation. A new attachment means a new HTTP/base URI owner.
- Hidden/paused/detached closes foreground ownership; inactive alone does not.
  Resume reconnects only if user intent remains active. SDK status updates trigger
  API/session revalidation after observed transport recovery, not write replay.
- Storage errors are visible; deletion failure can leave old records. App backup is
  disabled on Android. Hardware backup/restore, uninstall behavior, lock/unlock and
  iOS keychain retention are not guaranteed or accepted by these tests. Clear local
  credentials explicitly when needed. Physical-device storage tests remain.

## Acceptance

Additional JSON failure acceptance is recorded in [the shared matrix](../../../docs/json-acceptance.md)
from the repository root (`docs/json-acceptance.md`). Run the fixture with `--ui`
for tap-driven pairing/login/CRUD/logout/forget, `--failures` for real host restart,
upstream outage and dropped POST/PATCH/DELETE responses, or `--process-restart`
for release secure restore after force-stop and relaunch. The last mode resets only
this disposable demo app's local storage before seeding. These modes pass locally
on the ARM64 16 KiB emulator; physical device acceptance remains open.

From repository root after building the API and a ticket-capable CLI:

```sh
LOCHO_BINARY=/absolute/path/to/locho node scripts/flutter-fixture.mjs
LOCHO_BINARY=/absolute/path/to/locho node scripts/flutter-fixture.mjs --release
```

`LOCHO_DEVICE` defaults to emulator-5554. Fixture creates an isolated API, two users,
real Locho host and temporary mode-0600 ticket input, then cleans up. Debug integration
and autonomous release acceptance use the app controller/real secure storage to
verify CLI-ticket pairing, health, login, CRUD, two-user isolation, suspend/resume,
session recreation, remember-off, saved-token removal, logout and forget. These are
controller/runtime journeys, not a complete tap-driven UI acceptance suite. Widget
tests cover the initial credential UI. Public N0 discovery is environment-dependent;
tests do not claim a particular selected transport path.

Use a disposable emulator for acceptance, especially `--process-restart`, which
clears only the demo application's storage. The runner checks the selected device
ABI and builds release acceptance for ARM64 or x86_64 accordingly. It force-stops
its demo app and removes its reverse-port mapping after a run. It does not change
your emulator images, host identity or Flutter SDK installation.

The `android-runtime` CI job now executes basic/controller, tap-driven UI, failure,
cookie-browser event interoperability, release and real process-restart journeys on
an API 36 x86_64 emulator. Its logs report ABI/API/page size. APKs and dart-define
files embed disposable tickets and must not be uploaded as artifacts. Android
ARM64/16 KiB acceptance and physical devices remain separately identified evidence.

Local Android ARM64 16 KiB emulator debug acceptance and ARM64/x86_64 debug/release
builds pass; autonomous release acceptance passes. iOS build CI is separate from
physical iOS runtime evidence. Physical-device notes acceptance, real network
transitions, secure storage backup/uninstall matrix, QR and WebSockets remain
open. Unsigned iOS and development-signed APKs are not store releases.
