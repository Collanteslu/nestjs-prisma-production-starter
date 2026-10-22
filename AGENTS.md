# AGENTS.md

Guide for AI coding agents (and humans) working on this repository. The step-by-step
verification of behaviour is the executable contract in [`contract/`](contract/) (see
"Contract parity"), and the user-facing reference for endpoints, configuration and the
security model lives in the generated documentation at `/docs` once the server runs.

**Stack:** NestJS 12 · Prisma 7 with the libSQL driver adapter (SQLite file locally,
optionally Turso) · Zod 4 + `nestjs-zod` · Jest + supertest · ESLint + Prettier ·
Node.js 24 (`engines.node >=24.9`; the Docker base image is `node:24-alpine`).
`.npmrc` sets `legacy-peer-deps=true` — a documented exception required by the current
peer-dependency graph; do not remove it without resolving the conflicts properly.

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

CI (`.github/workflows/ci.yml`) runs the same list plus a Docker image build and the Jest
suite with coverage (`npm run test:cov`). Tests create and migrate their own temporary
SQLite database (`test/setup-env.ts` + the `beforeAll` of `test/app.spec.ts`), so `dev.db`
is never touched. `npm run test:e2e` (`test-api.sh`) is an optional curl suite against a
running dev server: it needs the demo accounts and `AUTH_MODE=full`.

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

| Mode | Mounted | Not mounted (404, absent from `/openapi.json` and `GET /`) |
|---|---|---|
| `full` (default) | everything: auth, recovery/verification, MFA, sessions, users, tasks, audit | — |
| `basic` | `/api/auth` register/login/refresh/logout, `/api/sessions`, `/api/users`, `/api/tasks`, `/api/audit-logs` | recovery, email verification, `/api/auth/mfa/*`, `DELETE /api/users/:id/mfa` |
| `none` | `/api/tasks` (public, ownerless) and the system routes | every auth, user, session, recovery, MFA and audit route |

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
  the second factor in every mode. The MFA *routes* (`MfaRoutesModule`) exist only with
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
   `src/rate-limit/rate-limit.decorator.ts`.
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
`environments/Local.bru` only holds `baseUrl`. There is no automated docs-parity check in
this repository: keep the collection in sync by hand.

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

## Useful files

| Path | What |
|---|---|
| `src/config/env.ts` | Env schema, cross-field validation, `featuresOf` |
| `src/database/migrations-guard.ts` | Startup guard: DB migration history vs `prisma/migrations` |
| `src/main.ts` | Boot order: config → connect → pragmas → guard → seed → cleanup → shutdown hooks → listen |
| `src/app.module.ts` | Conditional module mounting by features; global guards, pipes, interceptors |
| `src/configure-app.ts` | Helmet, CORS, body parsers, middleware, Swagger + Scalar |
| `src/common/` | Decorators (`@Public`, `@RateLimit`, `@TopLevelEnvelope`), pipes, interceptors, filters, middleware |
| `src/<recurso>/` | One module per resource (controller + service + `dto/`) |
| `src/jobs/cleanup.service.ts` | Periodic purge of expired sessions, tokens, buckets and old audit rows |
| `test/app.spec.ts` | Jest integration suite: HTTP infrastructure over the real surface |
| `contract/` | Executable parity spec (scenarios per group, one per `AUTH_MODE`) |
| `bruno/` | Bruno collection (runtime tokens never committed) |
