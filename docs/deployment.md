# Deployment and reproducible handoff

## Prerequisites and artifact retention

Use Node 24.18.0, npm 11.16.0 and Docker Compose v2+ with support for health-based
dependencies and `up --wait`. Images are version-tagged; Locho source is additionally
pinned to full Git revision `4f8aa20c3bcbabb667ef2354510bdb101d690fa6`. Image tags and
OS package repositories are not immutable digests; these Docker builds are repeatable
instructions, not hermetic/reproducible-bit guarantees. Record built image IDs for
your deployment and review base-image updates deliberately.

Before installing the Node workspaces, supply the pinned browser SDK:

```sh
npm run sdk:setup
npm ci
npm run check
```

Artifact resolution order is explicit local archive, verified local cache, HTTPS
mirror URL (when configured), then the pinned GitHub Actions run. Checksums always
remain those in compatibility.md and setup scripts; a corrupt cache fails closed
rather than silently selecting another package. Flutter uses the equivalent setup
script before `flutter pub get`.

```sh
LOCHO_SDK_ARCHIVE=/retained/locho-web-0.1.0-dev.3.tgz npm run sdk:setup
LOCHO_FLUTTER_ARCHIVE=/retained/locho_flutter-0.1.0-dev.2.tar.gz python3 scripts/setup-flutter-sdk.py
# Or an operator-maintained immutable HTTPS location serving those exact bytes:
LOCHO_SDK_URL=https://artifacts.example.org/sdk/locho-web-0.1.0-dev.3.tgz npm run sdk:setup
LOCHO_FLUTTER_URL=https://artifacts.example.org/sdk/locho_flutter-0.1.0-dev.2.tar.gz python3 scripts/setup-flutter-sdk.py
```

The example hostname above is a placeholder, not a deployed service. Mirror
redirects are rejected and downloads are bounded to 16 MiB. Keep both original
archives, SHA-256 values and their CI/source provenance in durable operator-owned
storage before GitHub retention expires. This change provides the verified mirror
mechanism; it does not publish releases or provision a permanent artifact service.
Neither archive contains deployment/user credentials. Never put generated tickets
or backend tokens in the artifact store.

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
for HTML, no-referrer, nosniff and CSP. CSP allows WebAssembly compilation and N0
HTTPS/WSS endpoints; applications choosing custom discovery/relays must add only
their required origins. No blanket TLS/certificate bypass is configured for users.
This configuration hosts at `/`; for a subpath set Vite `base` and adjust Caddy
routing together. General package `/sdk/` support was verified separately in Locho.

## Automated acceptance and evidence

```sh
npm run build
npx playwright install chromium firefox webkit
npm run test:artifacts
npm run test:deployment
```

The deployment verifier uses a uniquely named disposable Compose project. It builds
from a checked-out tree, asserts no backend port mapping, seeds and waits for API
health, generates a real ticket, and runs packaged-browser login/create/delete/logout
on Chromium, Firefox and WebKit. It repeats the journey against a Caddy static HTTPS
container with real CSP, secure-context, MIME/cache/header assertions. Finally it
deletes only its own project's volumes and temporary credential file.

Local macOS Docker ARM64 acceptance passed both three-browser journeys. The HTTPS
test uses Caddy's internal CA, with `ignoreHTTPSErrors` enabled **only for this
test invocation**; production uses public certificate verification. Thus CSP/HTTPS
transport/asset checks are demonstrated, but public DNS/ACME trust and actual public
hosting remain operator/device acceptance, not claimed as completed. Container
builds and public N0 require network access. Cold builds can be lengthy.

CI runs the same verifier on Linux from a fresh checkout. Physical mobile/iOS,
real network changes, backup/uninstall storage observations, controlled authenticated
relay testing, SSE and WebSockets remain separate gates.
