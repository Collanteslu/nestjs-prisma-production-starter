# AGENTS.md

Guide for AI coding agents (and humans) working on this repository. The step-by-step
verification of behaviour is the executable contract in [`contract/`](contract/) (see
"Contract parity"), and the user-facing reference for endpoints, configuration and the
security model lives in the generated documentation at `/docs` once the server runs.

**Stack:** NestJS 12 · Prisma 7 with the libSQL driver adapter (SQLite file locally,
optionally Turso) · Zod 4 + `nestjs-zod` · Jest + supertest · ESLint + Prettier ·
Node.js 24 (`engines.node >=24.9`; the Docker base image is `node:24-alpine`, pinned
by digest).

**No install overrides.** npm resolves the tree strictly: there is no
`legacy-peer-deps`. The one package that forced it — `nestjs-zod`, whose published
peers stop at Nest/Swagger 11 — is **vendored** at `vendor/nestjs-zod` (byte-identical
`dist/` of 5.5.0, MIT, attribution in its `LICENSE`) with only `peerDependencies`
removed: every declared peer is satisfied by this project's own dependencies, so the
installer disagreement had no runtime meaning, while the strict install now surfaces
ANY real conflict instead of hiding them behind the flag. **Exit criteria:** when
Dependabot proposes a `nestjs-zod` release whose peers include Nest/Swagger 12,
delete `vendor/nestjs-zod` and depend on the registry version again. The
integration is covered by the safety net that runs on every change:
`npm run typecheck` and `npm run build` against the real types, the Jest suite
(which validates the generated document with `@apidevtools/swagger-parser`), and the
contract harness (108 document/response pins across the three modes) — all in CI.

## Install and run

```bash
npm ci
cp .env.example .env
# Two distinct secrets (not needed with AUTH_MODE=none)
sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|; s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env && rm .env.bak
npx prisma generate        # Prisma 7 never generates the client implicitly (also run by prebuild)
npx prisma migrate deploy  # creates/updates dev.db
npm run dev                # http://localhost:3011 (docs at /docs)
```

Outside production an empty database is seeded with demo data (`admin@example.com` /
`ana@example.com`, password `password123`; with `AUTH_MODE=none`, two public tasks).
Environment variables are validated in `src/config/env.ts` and `main.ts` exits with a
readable message when a combination is invalid (`loadEnv()` fails fast before anything
touches the network or the database).

## Checks (all must pass before opening a PR)

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev --audit-level=high
npm test                    # Jest: crea y migra su propia BD SQLite temporal
```

Formatting is enforced by Prettier through Husky + lint-staged on every commit.

CI (`.github/workflows/ci.yml`) runs the same list plus a Docker image build, a Trivy
scan of that image (HIGH/CRITICAL with a fix available fail the job), a **CycloneDX
SBOM** published as a build artifact, the Jest suite with coverage floors for the
security-critical files, and a `contract-parity` job that executes the contract harness
in **each** `AUTH_MODE` (fresh migrated SQLite database, server boot with health check,
mode's groups; the runner provides the SMTP sink for `recovery`). Actions are pinned by
commit SHA and the base image by digest; Dependabot (`.github/dependabot.yml`) opens
weekly PRs for npm, Docker and Actions updates. **Image signing decision:** deferred on
purpose — CI only builds the image locally and never pushes to a registry, so there is
nothing to attest yet; when a registry is configured (ghcr.io or similar), add
`cosign sign --yes` with GitHub OIDC keyless identity and make deploy verify with
`cosign verify`. Until then the integrity chain is: digest-pinned base, SHA-pinned
actions, `npm audit`, Trivy gate and the SBOM artifact.
Tests create and migrate their own temporary SQLite database (`test/setup-env.ts` +
the `beforeAll` of `test/app.spec.ts`), so `dev.db` is never touched.
`npm run test:e2e` (`test-api.sh`) is an optional curl suite against a running dev
server: it needs the demo accounts and `AUTH_MODE=full`.

## Contract parity

`contract/` is the executable specification replicated from the reference project: HTTP
scenarios grouped in `auth`, `sessions`, `tasks`, `users`, `audit`, `system`, `mounting`,
`recovery` and `mfa`. Every phase of this repository was gated on it.

```bash
npm run build && PORT=3011 npm start &
npm run contract -- --base http://127.0.0.1:3011 --mode full --db ./dev.db --group auth
```

Run the groups per mode: `full` runs all nine; `basic` runs `auth sessions tasks users
audit system mounting`; `none` runs `tasks system mounting`. The `recovery` group needs
the SMTP sink on port 2525 (the runner installs it by default). `contract/scenarios/
mounting.mjs` pins which routes exist in which `AUTH_MODE` — extend it when adding a
mode-dependent route.

## Authentication modes (`AUTH_MODE`)

| Mode             | Mounted                                                                                                   | Not mounted (404, absent from `/openapi.json` and `GET /`)                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `full` (default) | everything: auth, recovery/verification, MFA, sessions, users, tasks, audit                               | —                                                                            |
| `basic`          | `/api/auth` register/login/refresh/logout, `/api/sessions`, `/api/users`, `/api/tasks`, `/api/audit-logs` | recovery, email verification, `/api/auth/mfa/*`, `DELETE /api/users/:id/mfa` |
| `none`           | `/api/tasks` (public, ownerless) and the system routes                                                    | every auth, user, session, recovery, MFA and audit route                     |

How it is wired, so new code follows the same pattern:

- `featuresOf(env)` (from `src/config/env.ts`) is the only switch: `features.auth` (basic
  or full) and `features.accountSecurity` (full). Do not compare `env.AUTH_MODE` strings
  around the code.
- `AppModule.forRoot(env)` builds the `DynamicModule` and imports every resource module
  conditionally (`...(features.auth ? [SessionsModule, AuthModule, UsersModule,
AuditLogsModule] : [])`). A disabled module adds no route and nothing to the spec.
  Controllers stay registered unconditionally only when the reference does the same
  (`TasksModule`, `HealthController`, `SystemController`).
- `MfaModule` (TOTP/recovery-code services) is `@Global` and always imported: login checks
  the second factor in every mode. The MFA _routes_ (`MfaRoutesModule`) exist only with
  `features.accountSecurity`.
- `AuthPrefixMiddleware` (`src/common/middleware/`) authenticates the four protected
  prefixes and all their sub-paths, mirroring the reference's `app.use(prefix)` +
  `app.use(prefix + "/*")`: an unauthenticated probe of an unmounted sub-path answers 401,
  not 404. It is a no-op with `AUTH_MODE=none` and there are no `@Public()` routes under
  those prefixes.
- Cross-field rules belong in the `superRefine` of `src/config/env.ts` (JWT secrets
  required unless `none`; `ADMIN_*` rejected with `none`; `REQUIRE_EMAIL_VERIFICATION` and
  the production `APP_URL` check only apply to `full`).
- The Prisma schema and the migrations are identical in every mode (`Task.userId` is
  optional so tasks can be ownerless with `none`). Switching modes needs no migration.
- `AUTH_MODE` is read once at startup (`loadEnv()` in `main.ts`, injected via
  `AppModule.forRoot(env)` — never `process.env` at import time). Tests for another mode
  run the contract harness against a server started with that mode.

## Proxy deployments (`TRUST_PROXY`)

The client IP feeds the per-IP rate limits, the login lockout and the audit trail, and
Express can only distinguish the real client when the trust configuration matches the
**exact** deployment topology:

1. **Network**: in production the API must be reachable ONLY through the proxy — if a
   client can hit it directly, it can send its own `X-Forwarded-For` and pick the
   address the limits key on. Close port 3011 at the firewall/security-group level
   (docker-compose already binds `127.0.0.1` only).
2. **Header ownership**: the proxy must OVERWRITE (or append to) `X-Forwarded-For` —
   never pass a client-supplied header through untouched. The app reads only
   `X-Forwarded-For`, from the right, and ignores `CF-Connecting-IP`/`X-Real-IP`.
3. **Exact hops**: set `TRUST_PROXY=true` and `TRUST_PROXY_HOPS` to the number of
   trusted proxies in front of the API (1 = Traefik/Nginx; 2 = Cloudflare + Traefik).
   Too many hops trusts attacker-controlled entries; too few makes everyone share one
   bucket (self-DoS). Express gets the numeric value, never `true`.
4. **Verify per deployment** (document the result with the rollout):
   - `curl -H "X-Forwarded-For: 1.2.3.4" https://your-api/api/auth/login` (bad password)
     from OUTSIDE the proxy → the audit entry's `ipAddress` must be the caller's real
     address, never `1.2.3.4`; from a direct connection, the port must be unreachable.
   - Automated both-posture coverage: `test/trust-proxy.spec.ts` pins that
     `X-Forwarded-For` is ignored by default and honoured for exactly the configured
     hop count when enabled.
5. **TLS termination**: when TLS terminates at the proxy, emit **HSTS** there (the API
   serves plain HTTP; Helmet's HSTS header is ignored by browsers over HTTP). When this
   process terminates TLS itself, Helmet already sends `Strict-Transport-Security` with
   its default max-age — verify which one applies in your topology and keep exactly one
   authoritative issuer.
6. **Reference configuration** (nginx, TLS at the proxy, API bound to localhost only):

   ```nginx
   server {
     listen 443 ssl;
     server_name api.example.com;
     # ssl_certificate … (emite HSTS aquí, con header Strict-Transport-Security)
     location / {
       proxy_pass http://127.0.0.1:3011;
       proxy_set_header Host $host;
       # SOBRESCRIBE la cabecera: la del cliente nunca se reenvía.
       # ($proxy_add_x_forwarded_for también es seguro con TRUST_PROXY_HOPS=1,
       #  porque la API confía solo en la última entrada — la que añade el proxy.)
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

   Traefik: `forwardedHeaders.strategy: Host` (o `insecure: false` con sus IPs de
   confianza) reescribe las cabeceras del cliente; Caddy lo hace por defecto. Whatever
   the proxy: the app sets `TRUST_PROXY=true` + `TRUST_PROXY_HOPS` to ITS hop count
   only, and step 4's verification is executed against that deployment.

## Security decisions and trade-offs (audit log)

Deliberate choices inherited from the reference and kept, with their compensations:

- **Account-based lockout (item 4).** `LOGIN_LOCKOUT_*` counts failures per ACCOUNT, so
  anyone who knows an email can keep it locked for up to `LOGIN_LOCKOUT_MINUTES` — a
  bounded denial of service against that one account, accepted as the price of stopping
  credential stuffing that rotates IPs (distributed attacks also burn the per-IP
  `LOGIN_RATE_LIMIT_MAX`). Compensations: the lockout is time-boxed and self-healing
  (no operator action; the clock restarts on each failure), engagement is logged as a
  `WARN` line with a pseudonymous account reference for alerting, and the raw addresses
  never appear in logs. Recovery options for a locked user: wait out the window, or an
  operator computes the bucket key with `node --env-file=.env scripts/lockout-key.mjs
<email>` (the tool is pinned to `pii.ts` by test) and clears that `RateLimitBucket`
  row.
  Progressive backoffs were evaluated and rejected for now: they would diverge from the
  reference's contract and complicate the deterministic tests for marginal gain at a
  15-minute bound.
- **Rate limiter under store failure (item 5).** With `RATE_LIMIT_ON_DB_FAILURE=local`
  (default) a database outage does NOT disable protection on the credential surface:
  login, register, refresh, recovery and MFA keep a per-process fixed window
  (correct for a single instance; degrades to per-instance limits across replicas),
  while every failure is logged (`Rate limit store unavailable…`) and counted in
  `RateLimitGuard.metrics` (`storeFailures`, `localAllowed`, `localBlocked`,
  `openAllowed`) — hook log-based alerting on those lines. `RATE_LIMIT_ON_DB_FAILURE=open`
  restores fail-open everywhere for availability-first deployments.
- **Wildcard CORS in production (item 15).** `CORS_ORIGINS=*` is rejected at startup
  unless `CORS_ALLOW_WILDCARD=true` makes the choice explicit and reviewable.
- **Registration reveals duplicates (enumeration).** `POST /api/auth/register` answers
  409 with the taken address, while every recovery flow answers identically whether or
  not the account exists. Kept on purpose for a starter template's signup UX and pinned
  by the contract; a deployment with strict enumeration resistance should switch the
  register flow to a generic "check your inbox" response (product decision, contract
  change required).
- **OpenAPI exposure.** `/docs` and `/openapi.json` default to enabled outside
  production (`ENABLE_DOCS`); in production they are OFF and publishing them must be an
  explicit `ENABLE_DOCS=true`. The document itself carries no server-side secrets.

## Account emails: durable outbox and links

- **Delivery (item 10).** The request only persists an `EmailOutbox` intent in the same
  transaction as its audit entry; a worker (kicked immediately, polled every 30 s)
  delivers with exponential backoff (5 attempts ≈ 15 min) and then parks the row as
  `failed` with a `WARN`/`ERROR` log — the hooks for delivery alerting. Pending rows
  survive restarts; tokens are minted AT DELIVERY time, so raw tokens never sit in the
  database. `MAIL_TRANSPORT=none` and undeliverable accounts retire rows immediately.
- **Safe re-request (item 10).** `POST /api/auth/forgot-password` and
  `/resend-verification` are the supported way to get a fresh link: they are rate
  limited per IP and per address (max 3/hour), answer 202 regardless of existence, and
  issuing a new token invalidates the previous pending one.
- **Token in the link (item 8).** Emailed links carry `?token=…` on the FRONTEND's
  page. The API already answers `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store` on every response, but the consuming page must also:
  load no third-party resources or analytics, remove the token from the address bar
  with `history.replaceState` as soon as it is read, and exchange it through the
  existing **POST** `/api/auth/reset-password` / `verify-email` endpoints (never a GET
  with the token in the query). Prefer a page served from your own origin.
- **Logging (item 1).** `MAIL_TRANSPORT=log` is development-only and rejected in
  production; no logger records message bodies or tokens — only subject and errors.
- **SMTP requires TLS in production.** The startup guard rejects malformed `SMTP_URL`s,
  non-`smtp(s)` schemes and URLs that disable verification (`ignoreTLS=true`,
  `rejectUnauthorized=false`); the nodemailer transport additionally sets `requireTLS`
  in production, so `smtp://` (submission, port 587) must upgrade with STARTTLS and
  `smtps://` (465) uses implicit TLS — a plaintext-only server fails to send rather
  than downgrade. Outside production no TLS is forced (local sinks, the contract
  harness on :2525).

## Personal data in logs and keys (item 9)

- Rate-limit and lockout buckets never store raw addresses: keys carry
  `pseudonym(JWT_SECRET, value)` — an HMAC-SHA256 with HKDF-derived material, normalized
  (trimmed/lowercased), so instances sharing the signing secret share the buckets and
  correlation works. Rotating `JWT_SECRET` rotates the pseudonyms (counters reset — fine
  for their short windows).
- Audit `details` store `account=<pseudonym>` instead of emails for LOGIN_FAILED,
  CREATE and DELETE_PERMANENT; the users list remains the place where authorized admins
  see real addresses. Access: `GET /api/audit-logs` is admin-only. Retention:
  `AUDIT_RETENTION_DAYS` (default 90, 0 = forever), purged by the cleanup job;
  outbox rows keep 30 days. Export: there is no bulk export endpoint by design —
  any future exporter must carry the same admin gate and retention review.

## Code conventions

1. **Controllers stay thin.** Routes are declared with decorators plus Swagger metadata
   (`@ApiOperation`, `@ApiOkResponse`, …) describing every status code the handler can
   return. Never write OpenAPI by hand: the document is generated from DTOs and
   decorators (`configure-app.ts` mounts Swagger + Scalar).
2. **Schemas and DTOs:** request schemas in `src/schemas/request.schemas.ts` (Zod 4);
   DTO classes in `<module>/dto/*.dtos.ts` via `createZodDto`, validated by the global
   `ContractValidationPipe`. DTO class names ARE the OpenAPI component names the contract
   pins — never use `.meta({ id })` (it crashes the Zod global registry).
3. **Envelope:** `TransformInterceptor` wraps `{ success, message?, data, meta }` on every
   route. `@TopLevelEnvelope` keeps the documented top-level shape of the token endpoints
   (login, refresh, `GET /api/sessions/me`); `@NoEnvelope` returns raw bodies (`/healthz`).
   Never return raw objects without `success` and `meta`.
4. **Relations and ownership:** `include` is an explicit whitelist; `User.password` is
   omitted by the Prisma client (`omit`), only login opts back in. Apply ownership
   conditions AFTER user filters. Exclude soft-deleted rows unless
   `includeDeleted === "true"`.
5. **Filters and sorting:** `filter[campo]` keys are parsed by the shared helpers with
   typed records (invalid values → 400). Admin-only listing parameters (`scope=all`,
   `userId`) are refused for non-admins.
6. **Security:** enforce ownership (`resource.userId === req.user.userId`; a resource of
   someone else answers 404); admin routes use `@UseGuards(AdminGuard)` (the role is read
   from the database, not the JWT); client IPs only via the shared `getClientIp`
   (honours `TRUST_PROXY`); multi-step writes (block/delete + session revocation, token
   rotation, password/email change + token invalidation) inside `prisma.$transaction`.
   Per-IP limits use `@RateLimit("…")` with the registry in
   `src/rate-limit/rate-limit.decorator.ts`. Passwords are hashed with **Argon2id**
   (OWASP baseline m=19 MiB, t=2, p=1; 72-byte schema cap keeps the legacy bcrypt path
   truncation-free); legacy bcrypt hashes keep verifying and are upgraded in place after
   the next successful login — never rewrite stored hashes in bulk.
7. **Audit:** mutating and security-relevant actions call
   `audit.record(req, { userId, action, entity, entityId, details })`.
8. **API messages** (errors and validation) are in English.
9. **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). Husky
   runs Prettier + ESLint on staged files.

## Database changes

1. Edit `prisma/schema.prisma`.
2. `npm run db:migrate -- --name <change>` (or `--create-only` to review the SQL first,
   then apply it with `npm run db:migrate`), then `npm run db:generate`.
3. Commit the migration folder. When a migration rewrites or discards data, say so in a
   SQL comment at the top and in the PR.
4. Never use `prisma db push` on real data, never edit an applied migration, and keep
   `prisma migrate diff … --exit-code` green.

SQLite is the only provider (`provider = "sqlite"`, libSQL adapter); Turso is selected at
runtime with `TURSO_DATABASE_URL`. The startup guard
(`src/database/migrations-guard.ts`) fails fast when the database history does not match
`prisma/migrations`.

## Bruno collection

Every new or changed endpoint needs a request in `bruno/<Module>/`. Tokens are runtime
variables set by the `Login *` post-response scripts and are never written to disk;
`environments/Local.bru` only holds `baseUrl`. The collection is validated LIVE by
`scripts/bruno-smoke.sh <baseUrl> [db]` (optional second argument resets the rate-limit
counters first — the preceding contract run leaves the demo accounts locked): it runs
all 36 files in a controlled order with fresh tokens, asserts each file's HTTP status
via the reporter, and encodes which endpoints are manual by design (pasted
tokens/TOTP codes → 400/409) and which are destructive (`Users/Delete User` is skipped
over the demo users). The Bruno CLI is invoked pinned-by-version through `npx` (or the
local bin if you install it yourself) and is deliberately **not** a devDependency: its
own tree carries unfixed advisories (axios/nanoid/js-yaml…) that would keep
`npm audit --audit-level=high` permanently red — the gate protects the application's
dependency graph; the CLI only speaks HTTP to localhost. CI runs the battery in the
`contract-parity` full leg — a URL or body that drifts from the API turns red there.

## Safety rules

- Never commit secrets, `.env*` files, tokens, SMTP credentials or Bruno runtime values.
  `.env.example` keeps the secrets blank on purpose.
- Never run anything against production data or production credentials; use the local
  `dev.db` or the temporary test database.
- Never relax a startup guard in `src/config/env.ts` to make something work; fix the
  configuration.
- Work on a feature branch and open a pull request (the template lists the checks); never
  push to `main` directly and never merge your own PR. Describe data-changing migrations
  and behaviour changes in the PR.

## Operation and security runbooks

> Every procedure below has been **rehearsed in an isolated environment** with
> `scripts/ops-rehearsal.sh` (scratch databases in tmpdir, ports 3913/3914 — never
> touches `dev.db` or the parity databases). A runbook is not "documented", it is
> `scripts/ops-rehearsal.sh <mode>` exiting 0: re-run it after changing the procedure.
> The rehearsals have caught real issues (anti-replay vs. TOTP steps; WAL not included
> in a naive file copy) — treat those lessons as part of the procedure.

- **Rotate `JWT_SECRET` / `JWT_REFRESH_SECRET`**: both are HS256 signing keys; rotating
  either invalidates the corresponding tokens immediately — access tokens die at once,
  refresh tokens at rotation, so every session re-authenticates. Procedure: generate two
  new distinct secrets (`openssl rand -base64 48`), deploy them together (never reuse
  one for both), announce the forced re-login, and verify `/api/auth/login` +
  `/api/auth/refresh` afterwards. Rate-limit/lockout pseudonyms are keyed with
  `JWT_SECRET` too, so their counters reset (harmless, short-lived).
- **Rotate the MFA encryption key (versioned)** — rehearsed as
  `scripts/ops-rehearsal.sh mfa-rotation`:
  1. Generate a new key and move the current value to `MFA_ENCRYPTION_KEY_PREVIOUS`
     (decryption-only) before setting the new one as `MFA_ENCRYPTION_KEY`.
  2. Restart every instance. Secrets keep decrypting (previous key accepted) and are
     re-encrypted with the new key lazily, on each user's next successful TOTP
     verification — no maintenance window.
  3. After every enrolled user has logged in once with 2FA (or a generous deadline),
     remove `MFA_ENCRYPTION_KEY_PREVIOUS`. NEVER rotate `JWT_SECRET` as a substitute:
     when no dedicated key is set, TOTP secrets derive from it and rotating it makes
     every authenticator undecryptable.
     The rehearsal proves all three properties end-to-end: enroll under K1 → TOTP login
     with K1-as-previous → TOTP login with ONLY K2 (i.e. the lazy re-encryption happened).
- **Revoke sessions**: users do it themselves (`DELETE /api/sessions/:id`,
  `POST /api/sessions/revoke-all`); admins use `POST /api/users/:id/revoke-sessions`;
  password reset and admin MFA reset revoke the target account's sessions inside the
  same transaction. A blocked user's sessions die at block time.
- **Backups (encrypted) and restore** — rehearsed as
  `scripts/ops-rehearsal.sh backup-restore`:
  1. Snapshot the live database with **`VACUUM INTO '<file>'`** (via `@libsql/client`):
     a consistent single file **including the WAL** — copying the `*.db` alone silently
     loses recent commits still in `-wal` (the rehearsal proved it). Equally valid:
     checkpoint first or copy `*.db` + `*.db-wal` + `*.db-shm` together.
  2. Encrypt at rest with an **authenticated** tool — `age`
     (`age -r "$recipient" -o backup.db.enc snapshot.db`, ChaCha20-Poly1305 AEAD).
     Do **not** use `openssl enc`: it is CBC without authentication (it provides no
     integrity) and it does not support authenticated modes such as GCM — so if you ever
     fall back to OpenSSL you must add a MAC over the ciphertext (OWASP Cryptographic
     Storage Cheat Sheet; `openssl-enc(1)`). With age, tampering fails decryption, which
     the rehearsal asserts explicitly (a flipped byte must be rejected).
  3. **Key handling**: `age-keygen` once per environment; the secret key lives in the
     secret manager (or a mode-0600 file / protected descriptor on the host) and is
     passed **by file** — `age -d -i /run/secrets/backup.key …` — never as a process
     argument or environment variable (both are visible in `ps`/crash logs). The
     rehearsal generates its throwaway key inside the scratch directory.
  4. Turso: use its point-in-time recovery; store `TURSO_AUTH_TOKEN` in the secret
     manager.
  5. **Restore into a scratch location** and prove it: boot the API against it with the
     matching `AUTH_MODE`, run `npx prisma migrate diff --from-migrations … --exit-code`,
     confirm data (login of a pre-backup user) and run the contract `system` group —
     exactly what the rehearsal script asserts. Schedule the rehearsal; an untested
     backup is not a backup.
- **Deployment secrets**: source of truth is the platform's secret store — host `.env`
  (mode 0600, gitignored; `.env.example` documents keys with values blank), Docker
  `--env-file`/secrets or an orchestrator's secret store (compose reads JWT__/MFA__ from
  the environment and refuses to start without them), CI values as **repository
  secrets** (the contract's JWT values in `.github/workflows/ci.yml` are throwaway test
  fixtures, never production secrets), cloud secret manager for Turso tokens. Secrets
  never enter images, logs, the repo, or Bruno files (runtime variables only).
- **Alert on the security log lines**: every hook below is a structured one-liner
  (level shown), matched with log-based alerting — no metrics endpoint is exposed on
  purpose, so the HTTP surface stays contract-identical:

  | Pattern                             | Level | Condition                     | Severity          | Response                                                                                                                                                                                                                                |
  | ----------------------------------- | ----- | ----------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `Rate limit store unavailable`      | ERROR | 1×                            | page              | DB incident. With `RATE_LIMIT_ON_DB_FAILURE=local` the credential routes stay covered per-process and the rest fails open; check the DB, then `RateLimitGuard.metrics` (`storeFailures`, `localAllowed`, `localBlocked`, `openAllowed`) |
  | `Account lockout engaged`           | WARN  | ≥5 distinct accounts / 10 min | warning           | Credential stuffing or lockout abuse; correlate with per-IP 429s. Affected users self-heal within `LOGIN_LOCKOUT_MINUTES`; support locates/clears the row with `node --env-file=.env scripts/lockout-key.mjs <email>`                   |
  | `Email delivery failed (attempt`    | WARN  | ≥3 / 10 min                   | warning           | SMTP degrading; watch for abandonments                                                                                                                                                                                                  |
  | `Email delivery abandoned`          | ERROR | 1×                            | page              | A user will never receive the message: inspect `EmailOutbox` (`status=failed`, `lastError`), fix the transport; the user re-requests the link                                                                                           |
  | `Email retired without delivery`    | WARN  | ≥5 / 10 min                   | warning           | `MAIL_TRANSPORT=none` or undeliverable accounts — a misconfiguration if unintended                                                                                                                                                      |
  | `Failed to persist audit log entry` | ERROR | 1×                            | page (compliance) | Audit gap: check DB writability; entries are lost until it recovers                                                                                                                                                                     |
  | `Email outbox drain failed`         | ERROR | 1×                            | page              | The delivery worker is broken — pending emails stall                                                                                                                                                                                    |

  In-process counters exist for probes and tests and are deliberately not HTTP-exposed
  (contract parity): `RateLimitGuard.metrics` and `EmailOutboxService.metrics`
  (`enqueued`, `sent`, `retried`, `failed`).

- **Routes protected locally when the store fails** (`RATE_LIMIT_ON_DB_FAILURE=local`,
  the default): the authoritative list is `CRITICAL_RATE_LIMITS` in
  `src/rate-limit/rate-limit.decorator.ts` — `login`, `refresh`, `register`,
  `forgot-password`, `reset-password`, `resend-verification`, `verify-email`, `mfa`
  (the credential-stuffing and token-guessing surface). When you add a rate-limited
  route that must survive an outage, add its name to that set — and to the alert rules
  above if it deserves one.

## Pre-production environment checklist (operational integration)

The repository deliberately does not provision your stack's own pieces (secret store,
proxy, SMTP provider, log pipeline) — they are environment-specific — but nothing below
is optional before real data flows. The rehearsals prove the **procedures** in
isolation; this checklist proves the **environment**. Record each item (date,
environment, result) with the rollout.

1. **Secrets**: provision `JWT_SECRET`, `JWT_REFRESH_SECRET`, `MFA_ENCRYPTION_KEY`,
   SMTP credentials, `TURSO_*` and the age backup key in the real store (host `.env`
   mode 0600, orchestrator secrets, cloud KMS). Verify: the app boots in production
   mode, `git grep <valor>` finds nothing, and a secret scan of the delivered image
   (`trivy image --scanners secret`) is clean.
2. **Proxy**: deploy the reference configuration (step 6 under _Proxy deployments_)
   with the real proxy, set `TRUST_PROXY`/`TRUST_PROXY_HOPS` to the real hop count, run
   the forged-`X-Forwarded-For` verification **from outside** and confirm exactly one
   HSTS issuer for the domain.
3. **SMTP**: point `SMTP_URL` at the real provider with production settings
   (`smtps://`, or `smtp://` + STARTTLS — TLS is forced by the app), send a real
   `forgot-password` to a mailbox you own and consume the link end-to-end; confirm the
   provider refuses plaintext (the fallback must fail, not downgrade). Align
   SPF/DKIM/DMARC with `MAIL_FROM`.
4. **Remote backups**: schedule the `VACUUM INTO` + `age` pipeline with the store's key,
   upload off-host, and **restore from the remote copy** running the same assertions as
   `scripts/ops-rehearsal.sh backup-restore` (`migrate diff`, login of a pre-backup
   user, contract `system` group). For Turso, execute the point-in-time-restore drill
   once.
5. **Alerts on a real provider**: the table under _Operation and security runbooks_ is
   the source of truth (patterns, thresholds, severities) — provision those rules in
   your log pipeline. Example for Grafana/Loki:
   `sum(count_over_time({app="nestjs-api"} |= "Email delivery abandoned" [5m])) > 0` →
   page; for Datadog, a log-monitor matching the same patterns with the same severity.
   The in-process counters (`RateLimitGuard.metrics`, `EmailOutboxService.metrics`) are
   available for an exporter if you need gauges — expose it on an internal port/flag so
   the public contract surface stays untouched.
6. **Image signing**: stays deferred while CI only builds and never pushes (decision in
   the CI section); enable cosign keyless (GitHub OIDC) the day images land in a
   registry and make deploys verify them.

## Useful files

| Path                               | What                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                | Env schema, cross-field validation, `featuresOf`                                                    |
| `src/database/migrations-guard.ts` | Startup guard: DB migration history vs `prisma/migrations`                                          |
| `src/main.ts`                      | Boot order: config → connect → pragmas → guard → seed → cleanup → shutdown hooks → listen           |
| `src/app.module.ts`                | Conditional module mounting by features; global guards, pipes, interceptors                         |
| `src/configure-app.ts`             | Helmet, CORS, body parsers, middleware, Swagger + Scalar                                            |
| `src/common/`                      | Decorators (`@Public`, `@RateLimit`, `@TopLevelEnvelope`), pipes, interceptors, filters, middleware |
| `src/common/utils/password.ts`     | Argon2id hashing + legacy bcrypt verify and progressive rehash                                      |
| `src/common/utils/pii.ts`          | `pseudonym()` — HMAC pseudonyms for keys and security logs                                          |
| `src/mail/email-outbox.service.ts` | Durable delivery worker (backoff, retries, metrics)                                                 |
| `src/<recurso>/`                   | One module per resource (controller + service + `dto/`)                                             |
| `src/jobs/cleanup.service.ts`      | Periodic purge of expired sessions, tokens, buckets and old audit rows                              |
| `test/app.spec.ts`                 | Jest integration suite: HTTP infrastructure over the real surface                                   |
| `contract/`                        | Executable parity spec (scenarios per group, one per `AUTH_MODE`)                                   |
| `bruno/`                           | Bruno collection (runtime tokens never committed)                                                   |
