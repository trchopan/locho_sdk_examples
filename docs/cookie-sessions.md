# Worker-managed cookie sessions

## Purpose and supported scope

Locho Notes demonstrates a static browser app accessing a private cookie-authenticated
backend over a TCP ticket. The page and module service worker consume the public
`locho_web` package. The worker reads `Set-Cookie` via `fetchWithMetadata` and
`fetchStreamWithMetadata`, maintains one narrowly scoped session and explicitly
attaches `Cookie` to authorized requests. It never updates the browser cookie jar.

This is **not** a general cookie jar, transparent third-party application gateway,
OpenLia compatibility proof, native HttpOnly isolation, or background-service promise.
The notes backend has been adapted to illustrate the pattern. Same-origin scripts
are trusted and can initiate authorized application operations.

## Published SDK baseline — 2026-10-25

The coordinated 2026-10-26 native alignment now also pins host CLI 1.3.0-beta.3 and
Flutter SDK 0.1.0-beta.3. The browser SDK and cookie-handler policy are unchanged.
See [native beta.3 acceptance](native-beta3-acceptance.md) for current runtime results.
The original browser-only handoff described below retained host/Flutter beta.1.

The browser pins `locho_web@0.1.0-beta.3` from npm, built from clean commit
`0c8ad57cc91af30144138bd324aeca86604f48dd`. Both metadata methods and
`LochoResponseWithMetadata` are present in its public declarations. Wire protocol 3
and ticket format 1 are unchanged; at that handoff Flutter and CI/Compose host pins
were unchanged at beta.1.
The previous local SDK archive is no longer used or included in this checkout.

Archive SHA-256:
`1dcbee155e6c59b8561c3fda3b3e20a15123ef9cb1808fb566ed6ceeb537bc65`.
`package-lock.json` records the registry URL and SHA-512 integrity.

Beta.3 includes relay-URL normalization (#124), but its changelog warns that this
does not establish resolution of all public-N0 timeouts. The prior Firefox cases
and the full local browser matrix pass against this installed registry package;
see the release-specific record below. This is runtime evidence, not an asserted
root-cause attribution or a promise of universal network reliability.

## Running

Follow the root README's API/Locho setup, then:

```sh
npm ci
npm run check
npm run dev:web
```

Open `http://127.0.0.1:5173`, paste the ticket, log in with a disposable demo account,
create/edit/delete notes and log out. Cookie mode is the default. For a comparison,
select bearer mode or open `/?auth=bearer`; that mode retains opt-in remembered
sessions. Password and ticket inputs clear on submission.

The dev command builds the production page/worker and serves them; rerun after
source changes. Production requires HTTPS; trusted localhost is permitted for local
testing. Serve the whole `apps/web/dist`, including `locho-notes-sw.js` and WASM.

## Architecture

```text
React UI / shared Session and NoteEventWatch
  → same-origin /__locho_notes__/ gateway (credentials: omit)
  → module worker / per-client pairing and GatewaySession
  → public SDK metadata APIs / Locho TCP
  → private /browser/auth/* and /browser/api/*
```

- `main.tsx` selects cookie or bearer integration. Cookie startup never reads IndexedDB.
- `cookie-transport.ts` validates worker readiness and sends pairing/control commands.
  A returned pairing holds an owner ID, not the ticket text. The worker holds the ticket.
  It reuses the existing registration and explicitly requests a scoped claim when an
  active worker is visible but the new window has no controller, as observed in Firefox.
- `notes-worker.ts` keys owners using browser-derived Client IDs, not page-supplied tab
  identifiers. Commands are serialized per client. At most 32 owners are admitted;
  disappeared clients are pruned on subsequent control activity.
- `gateway.ts` maps exact methods/paths. Absolute URLs, queries, arbitrary upstreams,
  credential injection and unknown operations are not supported. Request bodies are
  bounded to 64 KiB. Firefox's null `Request.body` path uses the native Blob reader,
  checks its size, then copies bytes. Native request/Blob buffers are outside the JS
  budget. The worker's authority is fixed to `sample-api`.
- `cookie-session.ts` recognizes only `locho_notes_session`, with `/browser/` path,
  no Domain, Secure/HttpOnly/SameSite=Strict and explicit expiry. Max-Age takes
  precedence; lifetime is capped at 30 days. Malformed/duplicate session updates clear
  authentication. Unknown cookie names are ignored; fields are never comma-split.
- Ordinary JSON uses buffered metadata; SSE uses streaming metadata. Metadata stays
  in the worker. Only Content-Type, Retry-After and no-store are forwarded. Redirects
  are rejected. Response bodies are not cloned/teed or accumulated for SSE.
- Transport failures remain failures, not fabricated backend rejection statuses in
  the UI. Interrupted writes show unknown outcome and are never automatically replayed.

The backend registers shared business handlers for both authentication namespaces.
Cookie sessions are separate database records tagged `cookie`; bearer tokens are
tagged `bearer`. They cannot be exchanged across routes. Both share users, notes,
rate limiting and the bounded event hub. Schema v1 upgrades to v2 transactionally,
preserving existing rows as bearer sessions.

## Credential and cross-origin policy

- The page necessarily handles ticket/password input transiently. It does not receive
  a cookie token in JSON, worker replies or response metadata.
- No cookie-mode credentials are written to IndexedDB, local/session storage or Cache
  Storage. Existing saved bearer credentials remain until explicitly forgotten in
  bearer mode; selecting cookie mode does not erase them or migrate them.
- Cookie routes require `X-Locho-Session-Mode: cookie`, reject Origin/Authorization
  headers and cross-site Fetch Metadata, and provide no permissive CORS. They are
  an explicit Locho SDK HTTP contract, not an ambient-cookie browser API.
- Worker gateway requests must originate from the same origin, carry the current
  owner's ID and map to an allowed operation. The ID is not a substitute for the
  browser-derived Client ID. Native Cookie/Authorization injection is rejected.
- Do not log metadata, cookies, tickets, passwords, arbitrary request/exception bodies
  or worker payloads. Tests disable traces/screenshots/video. Do not enable them with
  real credentials. User content is rendered as text, not backend HTML.
- Secure/HttpOnly/SameSite attributes document and constrain the demo contract; they
  do not gain native browser enforcement when handled in JS. Secure is not a claim
  of HTTPS between the Locho host and its local HTTP upstream. Locho transport and
  upstream deployment security remain separate concerns.

## Lifecycle

| Event | Result |
| --- | --- |
| Temporary peer failure | Hide protected UI; recover with health/me validation if worker state survives; never replay writes |
| SSE-only failure | Bounded retry, health/me validation, resubscribe and canonical refresh |
| 401 / expiry / deletion | Clear worker auth and protected UI; retain pairing for login |
| Logout | Capture cookie for revocation, clear locally immediately, process deletion; offline server revocation is unconfirmed |
| Disconnect | Abort requests/streams and close client; retain worker pairing but remove cookie |
| Reconnect | Reuse surviving pairing, create a clean client/session and require login |
| Ticket replacement | Discard old auth, including replacement tickets for the same service |
| Forget | Clear pairing/auth and cancel all owned work; not server revocation |
| Pagehide / fresh page | Best-effort cleanup; no automatic fresh-page restoration |
| Worker termination | All worker state disappears; stale IDs return a reset signal; page asks for pairing/login |
| Worker update | No skipWaiting; waits for old clients to close; no migration of sensitive state |

Revision checks prevent late responses from restoring auth after logout/close or
ticket changes. Client disconnect cancels Locho operations; streamed bodies retain
pull/cancel ownership. Page destruction cleanup is best effort. No keepalive traffic
or indefinite worker lifetime is promised, even with an active SSE response.

## Verification and release gates

```sh
npm run check
LOCHO_BINARY=/absolute/path/to/locho npm run test:browser
npm run test:deployment
```

Unit/API tests cover cookie transport separation, expiry/deletion, schema migration,
malformed/duplicate cookies, cross-origin rejection, sensitive-header stripping,
late login invalidation, bounded requests and stream cancellation. Existing bearer
and event tests remain regression gates. Contract fixtures contain dummy values only.

`apps/web/e2e/cookie.spec.ts` exercises production UI CRUD/logout, no persistence or
native cookie jar, independent tabs, mixed cookie/bearer live updates, ticket replacement,
fresh-page ownership, server expiry and lost-response mutations. Actual worker
termination uses Chromium CDP; Firefox/WebKit skip that particular test rather than
claiming equivalent termination coverage. Fresh-owner behavior is tested on all engines.
Tests explicitly forget live owners before closing contexts. The termination test
revokes disposable fixture sessions afterward: a killed worker cannot send cleanup,
and immediate upstream transport reclamation on eviction is not claimed.
Cookie tests also revoke prior disposable fixture sessions before each journey,
isolating cleanup counters from earlier legacy tests and browser contexts. This
control exists only in the local acceptance fixture, never in user deployments.
The shared Playwright fixture-control helper permits one network retry only for
the side-effect-free `status` snapshot (the fixture uses POST even for this read).
Playwright retries only `ECONNRESET`, not HTTP errors. All state-changing fixture
commands explicitly use zero retries. Persistent status failures and nonzero stream
counts still fail cleanup; application requests and whole browser tests are not retried.

The Flutter cross-browser harness now defaults to cookie mode; set
`LOCHO_CROSS_BROWSER_AUTH=bearer` to run the previous comparison journey. Changing
the harness is not new emulator/device evidence; rerun it before claiming acceptance.

Local registry verification is recorded below. Remaining acceptance gates are:

- Current native-release CI/Compose and runtime evidence is tracked in native-beta3-acceptance.md.
- Physical/mobile, public DNS/ACME, actual BFCache and broad real-network transitions.
- Firefox/WebKit actual worker termination and application subpath deployment.
- No universal third-party cookie/application compatibility claim.

PR #15's merged baseline passed hosted browser, Compose/Caddy HTTPS and Flutter
unit/build CI ([browser](https://github.com/trchopan/locho_sdk_examples/actions/runs/40202846912),
[deployment](https://github.com/trchopan/locho_sdk_examples/actions/runs/40202846954),
[Flutter builds](https://github.com/trchopan/locho_sdk_examples/actions/runs/40202846911)).
Its Flutter workflow did not run emulator integration tests; the new runtime job
and local ARM64 evidence must be assessed independently.

The historical 2026-10-24 SDK candidate came from clean commit
`977ee5d0208f5efdb8f2d7f9210890de1ca03155`;
SHA-256 `bfc8520be50c79037ed8d33e79ab965f27e6d41ed5df70b8137ed4cf6fa525bc`.
Its archive has been removed; this identity is retained only as historical evidence.

### Published beta.3 execution record — 2026-10-25

- Clean `npm ci` installs only registry dependencies, without the removed candidate
  directory. `npm run check` passes all 17 API and 29 browser unit/controller tests,
  lint/format/typechecking (including E2E sources and worker), contracts and both
  production builds.
- The four previously failing Firefox cases pass in a focused run: **4 passed**
  (33.8 seconds), using the reproduction filter retained in the historical record.
- **Full Chromium/Firefox/WebKit matrix: 55 passed / 5 expected skips (8.0 minutes).**
  All active cookie/bearer journeys, isolation, live updates, re-pair/reload recovery,
  expiry/logout, host restart, interrupted-write handling and Chromium actual worker
  termination pass. No test retries or automatic application-write replay were added.
- Expected skips remain three Compose-only cases without a deployed ticket and two
  non-Chromium actual-worker-termination cases; these are not successful verification
  of the skipped behavior.
- `npm run smoke:locho` passes real direct TCP health/login/notes/incremental SSE.
- `flutter test` passes all 28 tests with the unchanged pub.dev beta.1 SDK pin.
- Browser/smoke runtime used the published macOS ARM64 CLI **1.3.0-beta.1**, clean
  source `3786da3127338b2530e0cd8cea8ef23bc6d55dfd`, matching CI/Compose pins.
  Its release archive `locho-aarch64-apple-darwin.tar.xz` was checked against the
  published SHA-256:
  `23c7bb4a276e0b78ddf18e090107e533d531c4e9a698e473d7d185c7d1c9361b`.
  Executable SHA-256:
  `1eb06be92692fc809c42225ac7c577b2ced8d6d8ccd093f55ac3517e07820bfb`.
  The sibling checkout's changed/dirty debug binary was not used.
- The earlier candidate runs used a different local beta.2 host. This is not a
  controlled same-host A/B comparison proving that any single SDK change fixed
  those failures. It does demonstrate beta.3 working with the unchanged beta.1 host
  baseline, without upgrading the CLI or Flutter SDK.
- Docker daemon unavailable; Compose/Caddy HTTPS execution was not rerun. No Android
  device/emulator connected; cookie-browser/native interoperability remains open.
- The existing moderate `fast-uri` transitive npm advisory remains; no unrelated
  dependency upgrades were included in this alignment.

### Fixture status query regression — 2026-10-25

After the Chromium internal-CA fix, CI deployment and both Flutter jobs passed.
The browser job at `e136ffc` reported 54 passed / one failed / five skipped: the
failure was an `ECONNRESET` reading the loopback fixture's `/status` during Firefox
cleanup, not an application login/CRUD/logout failure. The exact socket-reset
trigger was not captured, so it is not attributed to a proven keep-alive defect.

The status-only retry policy above is tested using real local HTTP connections that
deliberately reset sockets. Regressions require recovery from one status reset,
failure after two resets, no replay of any fault/revocation/host command, no retry
of HTTP 500, and preservation of nonzero active-stream counts. This does not enable
whole-test retries or change Locho/application mutation behavior.

Local verification of this hardening passes `npm run check` (17 API and 35 browser
unit/controller/configuration tests) and the full real-host browser matrix: 55 passed,
five expected skips (9.9 minutes), using the same published beta.1 host baseline.

### Historical candidate execution record — 2026-10-24

- Clean `npm ci` followed by `npm run check`: passed (17 API tests, 29 browser
  unit/controller tests, contracts,
  lint/format/typecheck and production page/worker builds).
- Initial real-host Chromium smoke: all three initial cookie journeys passed.
- First expanded matrix: 42 passed / 10 failed / 5 skipped. It exposed Firefox's
  null worker Request.body, a missing deletion wait in the new test, and unreliable
  context-close stream cleanup. These were addressed, along with the new-window
  controller/claim handshake. A subsequent run was interrupted to correct test-helper
  errors; E2E sources are now included in TypeScript checking.
- **Candidate full matrix: 51 passed / 4 failed / 5 skipped (8.5 minutes).** Every active
  Chromium/WebKit case passed. Firefox failures were cookie ticket replacement and
  bearer idle-expiry restore, remembered logout restore and revoked-token restore.
  All six non-termination Firefox cookie journeys have passed in focused/local runs,
  but that is not stable full-matrix acceptance. Do not silently retry or replay writes.
- Focused rerun of those four Firefox failures: 3 passed / 1 failed; remembered logout
  restoration still failed. Reproduction:

  ```sh
  LOCHO_BINARY=/absolute/path/to/locho npx playwright test --project=firefox \
    -g 'fresh page ownership|idle session expiry|remembered logout|revoked remembered token'
  ```

  Similar post-reload health/restore symptoms were recorded in historical registry
  acceptance, but the cause of the current failures is unconfirmed. This remains a
  release blocker at that baseline, not an asserted upstream-only defect.
- Five expected skips: three Compose-only cases without a deployed ticket and two
  non-Chromium actual-worker-termination cases (no equivalent CDP control).
- `npm run smoke:locho`: direct TCP health/login/CRUD/incremental SSE passed.
- `flutter test`: 28 tests passed. No Android emulator/device is connected; native
  cookie-browser interoperability has not been rerun.
- Compose/Caddy execution is blocked locally: the Docker daemon is unavailable.
  Deployment code and checks were updated, but current HTTPS/CSP acceptance is unverified.
- The local real-host binary used for browser acceptance has SHA-256
  `0f987de89bb0921277fc15d5920d1b45e79433bd0414227ff74cf570efb4d36d`.
  It reports `1.3.0-beta.2`, clean commit `70b2a4e2a41d216a41ad3626942c4c22f32007c3`.
  Hosted CI/Compose continue building their explicitly pinned host baseline.
- `npm audit` reports an existing moderate `fast-uri` transitive advisory. No
  unrelated dependency upgrades were included in this feature change.
