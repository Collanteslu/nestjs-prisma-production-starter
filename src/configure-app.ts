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
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
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
