import type { INestApplication } from "@nestjs/common";
import { json, urlencoded } from "express";
import type { ErrorRequestHandler } from "express";
import helmet from "helmet";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { cleanupOpenApiDoc } from "nestjs-zod";
import { apiReference } from "@scalar/nestjs-api-reference";
import {
  BODY_LIMIT_BYTES,
  MALFORMED_JSON_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  buildErrorPayload,
} from "./common/error-payload";
import { requestContextMiddleware } from "./instrumentation/request-context";

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

/**
 * All raw-Express wiring shared by `main.ts` and the Jest e2e harness, in exact
 * execution order:
 *
 *   request-id/timing → helmet → CORS → body parsers (100 KiB) → parser-error
 *   envelope → /openapi.json + /docs (Scalar) → [Nest router: guards → pipes →
 *   interceptors → controllers]
 *
 * Settings pinned for parity with the reference (Express 5 defaults differ):
 *   - `query parser simple` → literal `filter[title]` keys (not qs-nested objects)
 *   - ETag disabled, X-Powered-By disabled (absent in the reference responses)
 */
export async function configureApp(app: INestApplication): Promise<void> {
  const express = app.getHttpAdapter().getInstance() as import("express").Express;
  express.set("query parser", "simple");
  express.set("etag", false);
  express.disable("x-powered-by");

  app.use(requestContextMiddleware);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.enableCors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  });
  app.use(json({ limit: BODY_LIMIT_BYTES }));
  app.use(urlencoded({ extended: false, limit: BODY_LIMIT_BYTES }));
  app.use(bodyErrorHandler);

  const config = new DocumentBuilder()
    .setTitle("Production REST API Template with NestJS, Prisma 7 & SQLite")
    .setDescription("API REST documentada con OpenAPI 3 + Scalar, con paridad demostrada.")
    .setVersion("2.0.0")
    .addBearerAuth({ type: "http", scheme: "bearer" }, "BearerAuth")
    .build();

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config), { version: "3.0" });

  app.use("/openapi.json", (_req: import("express").Request, res: import("express").Response) => {
    res.json(document);
  });
  app.use("/docs", apiReference({ spec: { url: "/openapi.json" } }));
}
