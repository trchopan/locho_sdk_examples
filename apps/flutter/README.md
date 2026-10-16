# Flutter notes application

Standalone Android/iOS foreground notes app using the delivered `locho_flutter`
source archive and the same API v1 as `apps/web`. No generated FRB imports or sibling
SDK Rust sources are required. This is a demonstration, not a background service.

## Setup

From the repository root, with authenticated GitHub CLI (or a retained archive):

```sh
python3 scripts/setup-flutter-sdk.py
# Alternative: LOCHO_FLUTTER_ARCHIVE=/path/to/archive.tar.gz python3 scripts/setup-flutter-sdk.py
```

The script verifies the pinned archive SHA-256 before extracting to ignored `vendor/`:
`288608ecc0c8eb72bd076dfca16e77c02a5e0a1d86adf85f272da34bb5426de5`.
Artifact: Locho run `38831899415`, `locho-flutter-source-package`, version
`0.1.0-dev.1`, source `0defbb54120e18360c7696052494c371a3640335`.
Its native/core Rust dependency is pinned to `4f8aa20c3bcbabb667ef2354510bdb101d690fa6`.
GitHub artifact retention can expire; keep a copy with this checksum. Do not replace
it silently with a new artifact bearing the same package version.

Then, from `apps/flutter`:

```sh
flutter pub get
flutter analyze
flutter test
flutter run -d emulator-5554
```

Use Flutter 3.44.5/Dart 3.12.2, Rust 1.96+, JDK 21 recommended, Android SDK 36+ and
NDK 28.2.13676358. Minimum Android API 23. Cargokit fetches pinned Rust sources and
builds native libraries with `--locked`. Cold builds need network access. iOS needs
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

Local Android ARM64 16 KiB emulator debug acceptance and ARM64/x86_64 debug/release
builds pass; autonomous release acceptance passes. iOS build CI is separate from
physical iOS runtime evidence. Physical-device notes acceptance, real network
transitions, secure storage backup/uninstall matrix, QR, SSE and WebSockets remain
open. Unsigned iOS and development-signed APKs are not store releases.
