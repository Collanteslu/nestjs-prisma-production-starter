import "reflect-metadata";
import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { featuresOf, loadEnv } from "../src/config/env";
import { PrismaService } from "../src/database/prisma.service";

/**
 * Integration suite over the real surface. The Fase B spike (which validated the stack
 * through throwaway /api/spike routes) was retired at integration; these tests keep every
 * infrastructure guarantee it pinned — validation, envelope, headers, error parity,
 * OpenAPI/Scalar — but exercised through the actual auth and tasks routes.
 */
describe("app: HTTP infrastructure over the real surface", () => {
  let app: INestApplication;
  let token: string;
  const account = {
    email: `jest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "Password123!",
  };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    // Fresh machines (and CI) start with an empty tmp database: migrate before boot.
    // `env` must be passed explicitly: prisma.config.ts resolves the datasource from the
    // child's environment, and an inherited-by-default env does not include DATABASE_URL.
    execFileSync("npx", ["prisma", "migrate", "deploy"], { encoding: "utf8", env: process.env });

    const env = loadEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app, env, featuresOf(env));
    await app.init();

    // The test database is persistent (tmpdir survives across runs): reset the per-IP
    // rate-limit counters so repeated runs are not throttled by their own history
    await app.get(PrismaService).rateLimitBucket.deleteMany({});

    // A real account, to exercise the authenticated surface
    await http()
      .post("/api/auth/register")
      .send({ name: "Jest User", email: account.email, password: account.password })
      .expect(201);
    const login = await http()
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);
    token = login.body.accessToken;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  describe("body validation (global ZodValidationPipe)", () => {
    it("applies schema defaults and strips unknown fields (POST /api/tasks)", async () => {
      const res = await http()
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Tarea de integración", unknownField: "must-be-ignored" })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        title: "Tarea de integración",
        description: "", // default aplicado
        completed: false, // default aplicado
      });
      expect(res.body.data.unknownField).toBeUndefined();
      expect(res.body.meta).toMatchObject({ apiVersion: "2.0.0" });
      expect(typeof res.body.meta.requestId).toBe("string");
    });

    it("devuelve 400 con errores agrupados por campo y meta", async () => {
      const res = await http()
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "X" })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Validation error in request payload");
      expect(Array.isArray(res.body.errors.title)).toBe(true);
      expect(res.body.meta.requestId).toBeDefined();
      expect(res.headers["content-type"]).toContain("application/json");
    });
  });

  describe("query validation (query parser simple)", () => {
    it("valida query inválida con 400 agrupado", async () => {
      const res = await http()
        .get("/api/tasks?page=0&limit=abc")
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
      expect(res.body.errors.page).toBeDefined();
      expect(res.body.errors.limit).toBeDefined();
    });

    it("aplica la paginación por defecto y acepta claves filter[...]", async () => {
      const res = await http()
        .get("/api/tasks?filter[title]=hola&sort=-createdAt")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toMatchObject({ page: 1, limit: 10 });
      expect(typeof res.body.pagination.total).toBe("number");
    });

    it("una tarea inexistente responde 404 con envolvente de error", async () => {
      const res = await http()
        .get("/api/tasks/task-no-existe")
        .set("Authorization", `Bearer ${token}`)
        .expect(404);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.message).toBe("string");
      expect(res.body.meta.requestId).toBeDefined();
    });
  });

  describe("envelope and serialization", () => {
    it("@TopLevelEnvelope extiende tokens en nivel superior (login)", async () => {
      const res = await http()
        .post("/api/auth/login")
        .send({ email: account.email, password: account.password })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Authentication successful");
      expect(typeof res.body.accessToken).toBe("string"); // en nivel superior…
      expect(typeof res.body.refreshToken).toBe("string");
      expect(typeof res.body.expiresIn).toBe("number");
      expect(typeof res.body.sessionId).toBe("string");
      expect(res.body.user).toMatchObject({ email: account.email, role: "user" });
      expect(res.body.data).toBeUndefined(); // …sin envolvente data
      expect(res.body.meta.requestId).toBeDefined();
    });

    it("errores de dominio conservan message y meta (409 registro duplicado)", async () => {
      const email = `dup-${Date.now()}@example.com`;
      await http()
        .post("/api/auth/register")
        .send({ name: "Dup", email, password: "Password123!" })
        .expect(201);
      const res = await http()
        .post("/api/auth/register")
        .send({ name: "Dup 2", email, password: "Password123!" })
        .expect(409);
      expect(res.body).toMatchObject({
        success: false,
        message: `Email '${email}' is already registered.`,
      });
      expect(res.body.meta.requestId).toBeDefined();
    });
  });

  describe("HTTP infrastructure", () => {
    it("JSON malformado → 400 con mensaje exacto del baseline", async () => {
      const res = await http()
        .post("/api/auth/login")
        .set("content-type", "application/json")
        .send('{"broken": ')
        .expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Malformed JSON in request body");
      expect(res.body.statusCode).toBeUndefined(); // el original no expone statusCode
      expect(res.body.meta.requestId).toBeDefined();
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.headers["x-response-time"]).toMatch(/ms$/);
    });

    it("cuerpo > 100 KiB → 413 con mensaje exacto del baseline", async () => {
      const res = await http()
        .post("/api/tasks")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "x".repeat(100 * 1024 + 64) })
        .expect(413);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe(
        "Payload Too Large: Request body exceeds the maximum permitted limit of 100 KB.",
      );
    });

    it("eco de X-Request-Id válido y rechazo del inválido", async () => {
      const echoed = await http().get("/healthz").set("x-request-id", "contract-echo.42");
      expect(echoed.headers["x-request-id"]).toBe("contract-echo.42");

      const rejected = await http().get("/healthz").set("x-request-id", "bad id spaces!");
      expect(rejected.headers["x-request-id"]).not.toBe("bad id spaces!");
      expect(rejected.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("cabeceras de tiempo y de seguridad del baseline", async () => {
      const res = await http().get("/healthz").expect(200);
      expect(res.headers["x-response-time"]).toMatch(/^\d+(\.\d+)?ms$/);
      expect(res.headers["server-timing"]).toMatch(/total;dur=\d/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(res.headers["etag"]).toBeUndefined();
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("sistema (healthz, índice y 404)", () => {
    it("GET /healthz responde con sonda SQLite y uptime", async () => {
      const res = await http().get("/healthz").expect(200);
      expect(res.body.status).toBe("healthy");
      expect(typeof res.body.timestamp).toBe("string");
      expect(typeof res.body.uptimeSeconds).toBe("number");
      expect(res.body.database).toMatchObject({ status: "connected" });
      expect(typeof res.body.database.latencyMs).toBe("number");
    });

    it("GET / lista los endpoints del modo activo (sin spike)", async () => {
      const res = await http().get("/").expect(200);
      expect(res.body.status).toBe("online");
      expect(res.body.authMode).toBe("full");
      expect(res.body.endpoints.healthcheck).toBe("/healthz");
      expect(res.body.endpoints.auth.login).toBe("POST /api/auth/login");
      expect(res.body.endpoints.mfa.setup).toBe("POST /api/auth/mfa/setup");
      expect(res.body.endpoints.tasks).toBe("GET, POST, PUT, DELETE /api/tasks");
      expect(res.body.endpoints.spike).toBeUndefined();
    });

    it("ruta inexistente → 404 con el mensaje exacto del baseline", async () => {
      const res = await http().get("/nonexistent").expect(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Route not found: GET /nonexistent");
      expect(res.body.meta.requestId).toBeDefined();
    });
  });

  describe("OpenAPI + Scalar", () => {
    it("/openapi.json es un documento OpenAPI 3 válido con BearerAuth y la superficie real", async () => {
      const res = await http().get("/openapi.json").expect(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(String(res.body.openapi)).toMatch(/^3\./);

      const doc = JSON.parse(JSON.stringify(res.body));
      await SwaggerParser.validate(doc); // lanza si el documento no valida

      expect(doc.components.securitySchemes.BearerAuth).toBeDefined();
      expect(doc.paths["/api/auth/login"]).toBeDefined();
      expect(doc.paths["/api/auth/mfa/setup"]).toBeDefined();
      expect(doc.paths["/api/tasks"]).toBeDefined();
      expect(doc.paths["/api/users"]).toBeDefined();
      // La spike se retiró al integrar: no debe aparecer en el documento
      expect(Object.keys(doc.paths).some((p) => p.startsWith("/api/spike"))).toBe(false);
      expect(doc.info.version).toBe("2.0.0");
    });

    it("/docs sirve HTML de Scalar", async () => {
      const res = await http().get("/docs").expect(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text.length).toBeGreaterThan(500);
    });
  });
});
