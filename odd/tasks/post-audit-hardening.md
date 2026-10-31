# Post-audit hardening — nestjs-plantilla

Fixes the verified findings of the 2026-10-31 read-only audit (memory obs. #90).
Every MED finding was verified by the parent with `path:line` evidence before this
document was written.

## Specs

- S1 (deps gate): "`npm audit fix` (multer) — desbloquea la compuerta de PRs" — production
  `npm audit --omit=dev --audit-level=high` must exit 0 again. `deepmerge@4.3.1` (LOW) has no
  patched release: document as accepted residual risk, no downgrade.
- S2 (image): "Imagen → `node:24-alpine` (o migrar coherente CI+doc a la LTS que elijas)" —
  Dockerfile back to `node:24-alpine` (digest-pinned, same digest Dependabot replaced), aligning
  runtime with CI (Node 24) and AGENTS.md.
- S3 (cleanup tests): "Tests para `cleanup.service.ts` + coverage floor" — Jest suite pinning the
  purge behaviour (expired sessions/tokens/buckets, audit retention incl. 0=forever, outbox GC)
  plus a coverage floor in `jest.config.js`. Rehearsal mode stays optional (drop if time-boxed).
- S4 (compose): "compose: agregar las 3 claves faltantes al allowlist" — `CORS_ALLOW_WILDCARD`,
  `RATE_LIMIT_ON_DB_FAILURE`, `MFA_ENCRYPTION_KEY_PREVIOUS` pass through `docker-compose.yml`.
- S5 (config/seed): "`TRUST_PROXY` fail-fast + pseudonym en el seed log" — env schema rejects
  unrecognized `TRUST_PROXY` values instead of silently disabling; `seed.service.ts` no longer
  logs the raw `ADMIN_EMAIL`.
- S6 (api batch): "Swagger 202/401/403/404, lockout `>=`, comentario de backoff, rate limit en
  logout, quitar pino, enums `sortBy`" — pino removal rides the deps unit (T1); the rest fixes
  the documented-status drift, the lockout alert gap, the outbox backoff doc claim, an
  unthrottled `POST /api/auth/logout`, and `sortBy` enums aligned with `sort=`.

## Tasks

| ID  | Spec          | Route                    | Commit  |
| --- | ------------- | ------------------------ | ------- |
| T1  | S1 + S6(pino) | inline                   | 902c5ef |
| T2  | S2            | inline                   | f8f7284 |
| T3  | S4            | inline                   | 0a4b379 |
| T4  | S5            | inline, test-first       | b7ccdc5 |
| T5  | S3            | inline                   | bdb9ec8 |
| T6  | S6            | inline, contract-checked | e92fc36 |

## Log

- L1: "audita a fondo la aplicacion porfavor" — read-only audit delivered (4 explore agents +
  parent verification, memory obs. #90).
- L2: "ok dale" — user approves the 6-item prioritized plan exactly as listed in the audit
  report section 6; local work-unit commits on `fix/post-audit-hardening`, no push/PR.
- L3: feature closed at 413 authored lines across 6 work-unit commits (902c5ef, f8f7284,
  0a4b379, b7ccdc5, bdb9ec8, e92fc36) — the slice boundary. Evidence per task: T1 gates
  (audit/typecheck/build/Jest) green; T2 full docker build exit 0; T3 docker compose config
  shows the 3 keys; T4 RED→GREEN (65/65); T5 new cleanup suite 4/4 + floor (69/69 total);
  T6 Jest+lint+typecheck+build green and contract harness full-mode mounting/auth/sessions/
  tasks/users/system all OK against a scratch migrated DB.
