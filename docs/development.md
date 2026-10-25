# Backend development

Run all npm commands from the repository root. Workspace commands execute from
`apps/api`, including seed/reset and production startup.

| Environment | Default | Behavior |
| --- | --- | --- |
| `API_HOST` | `127.0.0.1` | Native private upstream bind |
| `API_PORT` | `8080` | Integer 1–65535 |
| `API_DATABASE` | `../../.data/notes.sqlite` | Path relative to `apps/api` |
| `API_SESSION_SECONDS` | `2592000` | Absolute session lifetime; 1–31536000 |
| `API_LOGIN_ATTEMPTS` | `10` | Attempts/email/window; 1–1000 |
| `API_LOGIN_WINDOW_SECONDS` | `60` | Rate-limit window; 1–86400 |

Each login creates a separate 32-random-byte base64url token. SQLite stores SHA-256
token hashes, not token plaintext. Passwords use Argon2id with 64 MiB memory,
three iterations, one lane and a 32-byte hash. Login of an unknown email performs
dummy verification and returns the same generic error as a wrong password.
The configurable attempt limiter keys normalized email hashes, not tunneled source
IPs. It has a 10000-key cap, rejects new keys when full and expires windows.
Limiter state resets on process restart; this is a reference sample, not distributed
authentication infrastructure.

The first database open creates users/sessions/notes/indexes and migrates to schema
v2, adding a checked `auth_mode` to sessions. Existing sessions become bearer sessions;
users, notes and hashes are retained. Each migration runs transactionally.
Back up retained databases before upgrading: the old v1 server rejects v2 databases,
so rolling back the server also requires restoring a pre-upgrade database backup.
WAL and foreign keys are enabled. Open rejects a newer unknown schema. Reset deletes
demo data through SQL; stop the server first. Use a private writable data directory.

## API behavior

See `contracts/openapi.yaml` and `schemas.json`. Responses are UTF-8 JSON; private
data/token responses have `Cache-Control: no-store`. Both SDKs transport ordinary
HTTP bytes through a TCP service. Local loopback Host values are supported.
The additive `/browser` namespace uses cookie-mode credentials and an explicit
`X-Locho-Session-Mode: cookie` marker. It rejects Origin/Authorization headers and
cross-site Fetch Metadata; no permissive CORS or ambient browser-cookie API is offered.
See [cookie sessions](cookie-sessions.md). Existing bearer routes remain unchanged.

- `/health` verifies API identity/version separately from Locho peer connectivity.
- Login returns `{token,expiresAt,user}`; `/api/me` validates saved sessions.
- Logout revokes only the current session; invalid/expired/revoked tokens return 401.
- Notes are scoped by user for every operation; foreign IDs and missing IDs return 404.
- Notes list sorts updated time descending, ID ascending for ties. PATCH is
  last-write-wins, not optimistic locking. Dates are UTC RFC 3339; IDs are opaque.
- Input schemas reject unknown fields/type coercion/empty PATCH. Additional validation
  enforces UTF-8 byte/scalar limits and well-formed Unicode. Title is trimmed,
  password is not. Request cap 64 KiB, 100 notes/user, serialized list cap 4 MiB.
- Errors use `{error:{code,message}}`; invalid payloads and internal errors never
  echo request fields, credentials, SQL or stack traces. Automatic request logging
  is disabled; failure diagnostics include request ID only.

Login test requests and bearer headers should be created locally in your HTTP tool,
not committed in shell scripts, URLs or analytics. An attachment capability gives
service access; it does not identify a backend user.

## Application rules

Both apps distinguish transport, API readiness and authentication. In bearer mode, remember
off means memory-only. Remember on stores ticket/token in browser IndexedDB or
mobile secure storage. Never save passwords. Scope tokens by full host ID and
service name/type, not relay/local port/capability secret.

Disconnect retains pairing/auth credentials; logout removes the local token and
revokes server state when reachable; forget removes pairing and its local token
but is not server revocation. Offline logout reports unconfirmed revocation.
Authenticated API 401 removes the token, retaining pairing. Transport failure
retains credentials. Restore/recover via health and `/api/me` before showing notes.
Interrupted mutations have unknown server outcome; offer refresh, never silently replay.

Cookie mode stores credentials only in worker memory; disconnect removes its cookie,
and a fresh page or worker loss requires pairing/login. Backend lifetimes above
30 days remain supported, but the demo worker caps its local cookie lifetime at
30 days. Server expiry/revocation remains authoritative.

## Platform and deployment notes

Android feasibility uses `locho/packages/locho_flutter/example`, not a duplicate
backend. Use a host ID/capability until shared tickets land. Physical Android is
available; physical iOS and local Xcode remain open gates. Android JNI/DNS setup,
FRB runtime lifetime, 16 KiB page compatibility and debug/release networking require
SDK/device evidence. iOS compilation in CI is not physical-device validation.

Native deployment is implemented now. Compose is a subsequent slice: its API must
bind a private reachable interface and Locho must use a numeric socket address
(current Locho TCP config does not accept a service DNS name such as `api:8080`).
Do not publish the API port as public web ingress. Static browser hosting uses HTTPS.

If health fails: verify the API is listening, the selected Locho service is TCP,
the upstream address is on the host/container running Locho, and the capability is
current. A Flutter HTTP socket close alone does not prove invalid authorization.
