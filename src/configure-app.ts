import type { INestApplication } from "@nestjs/common";
import { json, urlencoded } from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import helmet from "helmet";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { apiReference } from "@scalar/nestjs-api-reference";
import type { Env, Features } from "./config/env";
import {
  BODY_LIMIT_BYTES,
  MALFORMED_JSON_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  buildErrorPayload,
} from "./common/error-payload";
import { API_VERSION, requestContextMiddleware } from "./instrumentation/request-context";

/**
 * Body-parser errors happen BEFORE the Nest pipeline, so they are translated by a
 * raw-Express error handler registered right after the parsers — producing the same
 * envelope the global filter emits for everything else.
 */
export const bodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") {
    res.status(400).json(buildErrorPayload(MALFORMED_JSON_MESSAGE));
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json(buildErrorPayload(PAYLOAD_TOO_LARGE_MESSAGE));
    return;
  }
  next(err);
};

/** Documentation is enabled by default outside production (override with ENABLE_DOCS). */
export function docsEnabled(env: Env): boolean {
  return env.ENABLE_DOCS ?? env.NODE_ENV !== "production";
}

/**
 * Scalar renders its UI from an inlined script and stylesheet, which Helmet's strict
 * default CSP blocks. The relaxation is applied ONLY to /docs responses; every other
 * response keeps the default Helmet CSP (item 11: keep the exception scoped to the route
 * that needs it). `frame-ancestors 'none'` still prevents embedding the reference page.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * Request/response headers that protect the browser side of the account flows:
 * - `Referrer-Policy: no-referrer` — an emailed link carries a single-use token in its
 *   query string; the page that consumes it must never leak that URL to third-party
 *   resources through the `Referer` header (item 8; the consuming page should also be
 *   third-party-free and strip the token with `history.replaceState` — AGENTS.md).
 * - `Cache-Control: no-store` — token-bearing responses must not land in browser,
 *   proxy or CDN caches.
 */
export function securityHeadersMiddleware(
  _req: import("express").Request,
  res: import("express").Response,
  next: () => void,
): void {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
}

/**
 * All raw-Express wiring shared by `main.ts` and the Jest e2e harness, in exact
 * execution order:
 *
 *   request-id/timing → helmet → CORS → body parsers (100 KiB) → parser-error
 *   envelope → /openapi.json + /docs (Scalar) → [Nest router: guards → pipes →
 *   interceptors → controllers → built-in routing 404 translated by the filter]
 *
 * Settings pinned for parity with the reference (Express 5 defaults differ):
 *   - `query parser simple` → literal `filter[title]` keys (not qs-nested objects)
 *   - ETag disabled, X-Powered-By disabled (absent in the reference responses)
 */
export async function configureApp(
  app: INestApplication,
  env: Env,
  features: Features,
): Promise<void> {
  const express = app.getHttpAdapter().getInstance() as import("express").Express;
  express.set("query parser", "simple");
  express.set("etag", false);
  express.disable("x-powered-by");
  if (env.TRUST_PROXY) express.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(requestContextMiddleware);
  // Helmet with its default CSP ON (item 11): strict for every response except /docs,
  // which relaxes it below through a scoped override. HSTS ships with Helmet's default
  // (max-age with includeSubDomains): browsers only honour it over HTTPS, so it is a
  // no-op on plain-HTTP responses and effective when this process terminates TLS —
  // behind a reverse proxy the proxy should emit it instead (AGENTS.md, "Proxy").
  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use(securityHeadersMiddleware);
  // Scoped CSP exception for the Scalar UI: registered before the /docs handler so the
  // stricter Helmet policy above is replaced only for those responses
  app.use((req: Request, res: Response, next: () => void) => {
    if (req.url === "/docs" || req.url.startsWith("/docs/")) {
      res.setHeader("Content-Security-Policy", DOCS_CSP);
    }
    next();
  });
  app.enableCors({
    origin: env.CORS_ORIGINS.includes("*") ? "*" : env.CORS_ORIGINS,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  });
  app.use(json({ limit: BODY_LIMIT_BYTES }));
  app.use(urlencoded({ extended: false, limit: BODY_LIMIT_BYTES }));
  app.use(bodyErrorHandler);

  if (docsEnabled(env)) {
    const builder = new DocumentBuilder()
      .setTitle("NestJS REST API - Gestión de Usuarios y Tareas")
      .setDescription(
        features.auth
          ? `API REST con NestJS, Prisma 7 (SQLite), TypeScript, Zod, autenticación JWT con refresh tokens rotativos, sesiones con estado y rate limiting (AUTH_MODE=${env.AUTH_MODE}).`
          : "API REST con NestJS, Prisma 7 (SQLite), TypeScript y Zod, sin autenticación (AUTH_MODE=none): todas las rutas son públicas.",
      )
      .setVersion(API_VERSION);

    // The security scheme is only published when auth is mounted (the reference omits it
    // entirely with AUTH_MODE=none)
    if (features.auth) {
      builder.addBearerAuth(
        {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Copia el accessToken devuelto por POST /api/auth/login (formato: Bearer <token>)",
        },
        "BearerAuth",
      );
    }

    const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, builder.build()), {
      version: "3.0",
    });
    // In production the spec must not advertise localhost (Scalar "try it" would fail silently)
    document.servers = [
      {
        url:
          env.NODE_ENV === "production"
            ? (env.APP_URL ?? `http://localhost:${env.PORT}`)
            : `http://localhost:${env.PORT}`,
        description: env.NODE_ENV === "production" ? "Production" : "Local development",
      },
    ];

    // Parity with the reference's `documentForMode`: with AUTH_MODE=none the published
    // spec carries no security and no auth responses (the @ApiBearerAuth decorator cannot
    // see the injected config, so its output is adjusted here, together with any scheme
    // the decorator may have declared).
    if (!features.auth) {
      delete (document.components as { securitySchemes?: Record<string, unknown> } | undefined)
        ?.securitySchemes?.["BearerAuth"];
      for (const item of Object.values(document.paths ?? {})) {
        for (const operation of Object.values((item ?? {}) as Record<string, unknown>)) {
          if (typeof operation !== "object" || operation === null) continue;
          const op = operation as {
            security?: unknown;
            responses?: Record<string, unknown>;
          };
          delete op.security;
          if (op.responses) {
            delete op.responses["401"];
            delete op.responses["403"];
          }
        }
      }
    }

    app.use("/openapi.json", (_req: Request, res: Response) => {
      res.json(document);
    });
    app.use(
      "/docs",
      apiReference({
        pageTitle: "API Reference | NestJS + Prisma",
        spec: { url: "/openapi.json" },
      }),
    );
  }
}
