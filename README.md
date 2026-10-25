# NestJS + Prisma 7 Production REST API Starter

[![CI](https://github.com/Collanteslu/nestjs-prisma-production-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/Collanteslu/nestjs-prisma-production-starter/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![NestJS](https://img.shields.io/badge/NestJS-12-EA2845.svg)](https://nestjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748.svg)](https://www.prisma.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)

A reusable REST API starter built with NestJS 12, Prisma 7, SQLite/libSQL, Zod 4, stateful JWT sessions, account security, OpenAPI and Scalar. Its HTTP behavior is checked against the companion [Hono starter](https://github.com/Collanteslu/hono-prisma-production-starter).

## Features

- Selectable `AUTH_MODE=none | basic | full`; disabled modules are absent from routing and OpenAPI.
- JWT access tokens, hashed rotating refresh tokens, session revocation, login lockout and database-backed rate limits.
- User and task APIs, role checks, ownership enforcement, soft delete/restore and audit logs.
- Optional email verification, password recovery, TOTP MFA and recovery codes.
- Zod request validation, a consistent response envelope, request IDs and OpenAPI/Scalar at `/docs`.
- SQLite by default, with optional Turso/libSQL, versioned Prisma migrations and startup checks.
- Docker image, Docker Compose, Bruno collection and executable HTTP contract scenarios.

## Quick start

Requirements: Node.js 24.9 or newer and npm 11 or newer.

```bash
git clone https://github.com/Collanteslu/nestjs-prisma-production-starter.git
cd nestjs-prisma-production-starter
npm ci
cp .env.example .env
```

For `AUTH_MODE=basic` or `full`, set two different signing secrets in `.env`:

```bash
openssl rand -base64 48
```

Copy one generated value to `JWT_SECRET` and another to `JWT_REFRESH_SECRET`. Keep both out of source control. Then initialize and run the API:

```bash
npx prisma generate
npx prisma migrate deploy
npm run dev
```

The API listens at <http://localhost:3011>. In development, the empty database is seeded with `admin@example.com` and `ana@example.com`, both using the example password `password123`. Change or remove these accounts before using a shared environment.

## Authentication modes

| Mode             | Available surface                                                         |
| ---------------- | ------------------------------------------------------------------------- |
| `full` (default) | Auth, recovery, email verification, MFA, sessions, users, tasks and audit |
| `basic`          | Registration, login, refresh/logout, sessions, users, tasks and audit     |
| `none`           | Public tasks and system endpoints; no auth or user routes                 |

The Prisma schema is the same in each mode. `AUTH_MODE` is read at startup, so restart the server after changing it. See [AGENTS.md](AGENTS.md) for the full route and configuration behavior.

## API and tools

- `GET /healthz` checks the database connection.
- `GET /` describes the routes available in the current mode.
- `GET /openapi.json` serves the generated API document; `/docs` serves Scalar when docs are enabled.
- `bruno/` contains requests for the API. Set its Local environment to the URL of your running server.
- `contract/` contains HTTP scenarios for the `full`, `basic` and `none` modes.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm audit --omit=dev --audit-level=high
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
```

For HTTP contract checks, start the API on an isolated database and set `APP_URL` to the same base URL used by the contract runner when testing email links. For example, with a server at `http://127.0.0.1:3911`, run `node contract/run.mjs --base http://127.0.0.1:3911 --mode full --db /path/to/the-server.db`. The runner includes a local SMTP sink for recovery scenarios. Use separate databases for each mode.

## Docker

Set `JWT_SECRET` and `JWT_REFRESH_SECRET` in your environment or an untracked `.env` file, then run:

```bash
docker compose up --build
```

Compose stores the local SQLite database in a named volume and applies versioned migrations at startup. For production, configure stable signing secrets, a persistent database, trusted proxy settings and (for `AUTH_MODE=full`) a real SMTP transport and HTTPS `APP_URL`. See [.env.example](.env.example) for all options.

The image is based on `node:24-alpine` (pinned by digest) and is built to run with a read-only root filesystem: the Prisma schema engine is downloaded when the image is built, not on first start, and the runtime image has no npm, corepack or yarn. The Compose file already runs it with `read_only`, `cap_drop: ALL`, `no-new-privileges` and the port bound to `127.0.0.1`. To check a build the way production runs it (read-only filesystem, migrations, admin login, `HEALTHCHECK`, non-root user):

```bash
docker build -t nestjs-api:ci .
scripts/docker-smoke.sh nestjs-api:ci
```

The entrypoint validates the environment before it applies any migration, so a missing secret stops the container without touching the database. In production the logs are plain text (no ANSI colours); the API documentation at `/docs` and the link to it on `GET /` are off unless you set `ENABLE_DOCS=true`.

## License

MIT. See [LICENSE](LICENSE).
