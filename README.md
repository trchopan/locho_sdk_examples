# Locho SDK Examples

Full Flutter and browser application demonstrations sharing one reference notes
API. SDKs and tiny package smoke apps are maintained in the separate `locho`
repository. `apps/web` now demonstrates **worker-managed cookie sessions** by
default, with a separately selectable bearer/IndexedDB mode. It consumes
`locho_web` **0.1.0-beta.3** from npm, including the public metadata APIs; see the
[cookie-session guide](docs/cookie-sessions.md).
The browser-only handoff passed hosted browser and Compose/HTTPS CI. The current
[native beta.3 alignment](docs/native-beta3-acceptance.md) records the coordinated
host/Flutter upgrade and distinguishes build, emulator and physical-device evidence.
`apps/flutter` consumes
`locho_flutter` **0.1.0-beta.3** from pub.dev for foreground notes and opt-in secure
storage. Both apps support live note updates through the shared API. See
[Flutter setup](apps/flutter/README.md) and [compatibility](docs/compatibility.md).

## Quick start

Use Node **24.18.0** and npm **11.16.0** (see `.node-version`/`package.json`). Node's
SQLite API is used directly; Argon2 is a native dependency with prebuilt artifacts
for common platforms and a compiler requirement if source compilation is needed.

```sh
npm ci
npm run check
npm run seed
npm run dev:api
```

Dependencies install from npm/pub.dev using committed lockfiles. Browser installation
requires no SDK compilation, archive bootstrap or GitHub authentication. See
[browser app setup and acceptance](apps/web/README.md). Flutter uses `flutter pub get`
from `apps/flutter`; its SDK bundles native Rust sources and requires Rust/platform
build toolchains.

The API listens on `127.0.0.1:8080`. Check `http://127.0.0.1:8080/health` for
`{"service":"locho-notes","apiVersion":1}`. For a compiled run:

```sh
npm run build
npm run start:api
```

Development accounts, created only by the explicit seed command:

| Email | Disposable local password |
| --- | --- |
| `alice@example.test` | `alice-local-demo-only` |
| `bob@example.test` | `bob-local-demo-only` |

`npm run seed` preserves existing users/data. Stop the server before
`npm run reset`, which deletes all demo users, sessions and notes and reseeds them.
Override seed passwords with `DEV_ALICE_PASSWORD`/`DEV_BOB_PASSWORD` for an exposed
demo deployment. Passwords/tokens are never printed by the tools. Never reuse these
disposable defaults for another application.

SQLite data lives under ignored `.data/`. No deployed credentials, tickets, session
tokens or databases are committed. Response fixtures contain dummy values only.

## Locho setup

On the machine running the API, use the ordinary Locho host with the TCP definition:

The current host baseline is **Locho CLI 1.3.0-beta.3**, pinned by full release
revision in CI/Compose. No wire/ticket-format change or new browser requirement is
introduced by this native alignment. Verify downloads using the release checksums.

```sh
locho host --config deploy/locho.toml
```

In another terminal:

```sh
locho share sample-api --config deploy/locho.toml
```

Ordinary share prints an attach command. For the browser app, add `--ticket` and
paste the resulting credential into the app. Keep it private. The backend user
token and Locho capability are independent.

For a local CLI check, run the generated attach command and request
`http://127.0.0.1:8765/health`. Across networks, use the SDK loopback port returned
on the client; `127.0.0.1:8080` remains the homelab host's upstream.

Optional reproducible smoke with an installed/built Locho CLI:

```sh
LOCHO_BINARY=/absolute/path/to/locho npm run smoke:locho
```

This creates temporary host state, uses a direct loopback path, verifies
health/login/notes through a real TCP tunnel, and cleans up processes/state.

To verify the existing-ticket upgrade/rollback path with two trusted CLI binaries:

```sh
LOCHO_PREVIOUS_BINARY=/absolute/path/to/beta.1/locho \
LOCHO_BINARY=/absolute/path/to/beta.3/locho npm run smoke:host-upgrade
```

This uses disposable state and a production cookie-mode browser, not your deployed
host identity. It preserves the original ticket, config and notes across both swaps.

## Layout and contracts

```text
apps/api/                     # Fastify + SQLite, tests and seed tools
contracts/openapi.yaml        # canonical API v1
contracts/schemas.json        # shared request/response schemas
contracts/fixtures/           # credential-free decoding examples
deploy/locho.toml             # native TCP service config
docs/development.md           # configuration, API and troubleshooting
docs/compatibility.md         # tested artifacts and delivery gates
docs/roadmap.md               # next development slices/team handoffs
```

Both application consumers use exact SDK artifacts and committed lockfiles.
The Flutter app keeps its own Dart dependencies/builds; the web/API workspace keeps
Node dependencies. Backend and contract changes update both consumers together.

## Checks

Private-container backend and static HTTPS setup are documented in
[deployment and reproducible handoff](docs/deployment.md). Run `npm run test:deployment`
to verify the disposable Compose stack and Caddy HTTPS/CSP with packaged browser
clients installed from npm. Package-manager caches can accelerate repeated installs;
fresh installation verifies the lockfile integrity values. Current registry release
acceptance and remaining gates are recorded in [cookie sessions](docs/cookie-sessions.md).

`npm run check` runs Biome linting and formatting checks, TypeScript checking,
production compilation, backend tests, OpenAPI validation and fixture-schema checks.
Use `npm run format` to rewrite supported Node files after making changes. Tests cover
sessions, expiry,
revocation, two-user isolation, Unicode/byte limits, malformed requests, persistence,
safe diagnostics and a real HTTP listener. They use temporary/in-memory databases.

GitHub: https://github.com/trchopan/locho_sdk_examples. CI checks API/contracts,
controller tests and production browser UI against the pinned packaged SDK/host.
