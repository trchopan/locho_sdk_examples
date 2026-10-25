# Deployment and reproducible handoff

## Prerequisites and registry dependencies

Use Node 24.18.0, npm 11.16.0 and Docker Compose v2+ with support for health-based
dependencies and `up --wait`. Images are version-tagged; Locho source is additionally
pinned to full Git revision `3786da3127338b2530e0cd8cea8ef23bc6d55dfd` (`1.3.0-beta.1`). Image tags and
OS package repositories are not immutable digests; these Docker builds are repeatable
instructions, not hermetic/reproducible-bit guarantees. Record built image IDs for
your deployment and review base-image updates deliberately.

Install the Node workspaces with the committed lockfile:

```sh
npm ci
npm run check
```

The browser pins published `locho_web` 0.1.0-beta.3 from npm; the root lockfile records
its registry URL and SHA-512 integrity. No local SDK archive is required by installation
or the API Docker build.
Flutter pins `locho_flutter` 0.1.0-beta.1 from pub.dev;
run `flutter pub get` in `apps/flutter` using its committed hosted-package lockfile.
No archive bootstrap, vendor extraction or GitHub credentials are needed. Package-manager
caches can accelerate repeated installs; cold installs require registry access.
Flutter's SDK bundles Locho Rust sources but still needs the documented Rust/native
build toolchains. See compatibility.md for exact versions/checksums and acceptance.

## Private API and host via Compose

From the repository root:

```sh
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml run --rm seed
docker compose -f deploy/compose.yaml up -d --wait
docker compose -f deploy/compose.yaml exec locho locho share sample-api --config /etc/locho/locho.toml --ticket
```

Seed is explicit, idempotent and only creates missing users. Defaults are the
disposable local users in the root README. For a shared deployment, provide unique
`DEV_ALICE_PASSWORD` / `DEV_BOB_PASSWORD` via your local environment before running
seed; do not commit them or paste them into diagnostic output. Seeding an existing
account does not rotate its password. Do not run reset against a database to retain.

The API binds `0.0.0.0:8080` **inside its container**, on an internal-only network
at `172.30.89.10`. `locho.container.toml` uses this numeric address because current
TCP endpoint configuration does not resolve `api:8080`. If that subnet overlaps
your environment, change the Compose subnet, API static address and Locho endpoint
together. The Locho container also joins an egress network for N0 discovery/relays.
Neither API nor Locho publishes a host port. No application ingress gateway is used.

Named volumes retain SQLite data and host identity/service secrets independently.
`down` retains volumes; `down --volumes` permanently deletes both and invalidates
previous pairing/session data. Keep backups private, stop writers for a consistent
database snapshot, and restore identity plus database deliberately. Test restoration
before relying on a backup; automated backup acceptance is not provided here.
The API and host run as non-root users. The seed tool uses the same data volume
without networking. API health is distinct from relay reachability and application
login. Logs and health checks must not print tickets or auth data.

## Static HTTPS browser hosting

Build the browser, set a domain you control, then start the separate web stack:

```sh
npm run build --workspace @locho-examples/web
export NOTES_HOSTNAME=notes.example.org
docker compose -f deploy/compose.web.yaml up -d
```

Set DNS to the web host and allow inbound 80/443 for public ACME validation/HTTPS.
Caddy obtains normal browser-trusted certificates and persists them in its own
volumes. API/Locho can run on a different private machine; the website only serves
static assets. Never copy ticket or token data into the website image/configuration.

The provided Caddyfile sets WASM MIME, immutable caching for hashed assets, no-store
for HTML/worker, no-referrer, nosniff and CSP. CSP explicitly permits same-origin
workers, WebAssembly compilation and N0
HTTPS/WSS endpoints; applications choosing custom discovery/relays must add only
their required origins. No blanket TLS/certificate bypass is configured for users.
This configuration hosts at `/`. For a subpath set `VITE_PUBLIC_BASE=/your-path/`
for both build steps and adjust the Caddy root/routing, worker path and gateway
fallback together; application subpath deployment remains an acceptance gate.
The worker has a stable URL, no-store/updateViaCache:none and no skipWaiting.
An update waits for old clients to close; it must not replace active sessions
silently. Gateway requests that reach Caddy return 503/reset, never backend data.

## Automated acceptance and evidence

```sh
npm run build
npx playwright install chromium firefox webkit
npm run test:deployment
```

The deployment verifier uses a uniquely named disposable Compose project. It builds
from a checked-out tree, asserts no backend port mapping, seeds and waits for API
health, generates a real ticket, and runs packaged-browser login/create/delete/logout
on Chromium, Firefox and WebKit. It repeats the journey against a Caddy static HTTPS
container with real CSP, secure-context, MIME/cache/header assertions. Finally it
deletes only its own project's volumes and temporary credential file.

Historical bearer-mode macOS Docker ARM64 acceptance passed both three-browser journeys.
Cookie-mode deployment acceptance is tracked separately in cookie-sessions.md. The HTTPS
test uses Caddy's internal CA, with `LOCHO_LOCAL_TLS_TEST=1` enabling
`ignoreHTTPSErrors` **only for this test invocation**. Chromium additionally needs
a test-only `--ignore-certificate-errors` launch argument because its service-worker
script loader does not honor the context-level setting. That browser-process
override is confined to the disposable TLS test; it is not added to ordinary browser
launches, Firefox/WebKit launch options, or production application/Caddy configuration.
Never enable this test flag for real credentials or production trust acceptance.
Production uses public certificate verification. Thus CSP/HTTPS
transport/asset checks are demonstrated, but public DNS/ACME trust and actual public
hosting remain operator/device acceptance, not claimed as completed. Container
builds and public N0 require network access. Cold builds can be lengthy.

CI runs the same verifier on Linux from a fresh checkout. Physical mobile/iOS,
real network changes, backup/uninstall storage observations, controlled authenticated
relay testing, SSE and WebSockets remain separate gates.

### Chromium internal-CA regression — 2026-10-25

The first PR #15 deployment run passed all three plain-HTTP Compose cases and the
Firefox/WebKit HTTPS cases, but Chromium timed out before login. A minimal
self-signed HTTPS probe reproduced a service-worker registration `SecurityError`
with context-only `ignoreHTTPSErrors`; the Chromium launch override above allowed
registration and worker fetches to complete.

The fix passes `npm run check` (17 API and 31 browser unit/controller/configuration
tests). Configuration regressions verify that only the exact TLS-test opt-in adds
the Chromium argument; ordinary launches and Firefox/WebKit launch arguments are
unchanged. The actual Chromium `deployment.spec.ts` also passes with the updated
configuration, a self-signed Node HTTPS static server, the production CSP and a real
published beta.1 Locho host. This is not Docker/Caddy acceptance; the full Compose/
Caddy workflow must pass in CI after the fix is pushed.
