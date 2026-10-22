import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { featuresOf, loadEnv } from "../src/config/env";

/**
 * Fase B — spike de compatibilidad: NestJS 12 + TS 6 (CommonJS/nodenext) +
 * nestjs-zod 5 + Express 5 + Swagger 12 + Scalar, verificado sobre la app compilada
 * vía supertest. Es el contrato mínimo que debe pasar antes de construir módulos.
 */
describe("spike: NestJS 12 + nestjs-zod 5 + Express 5", () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const env = loadEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app, env, featuresOf(env));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("validación de body (ZodValidationPipe global)", () => {
    it("aplica defaults, anida, convierte y elimina campos desconocidos", async () => {
      const res = await http()
        .post("/api/spike/body")
        .send({
          name: "Luis",
          email: "luis@example.com",
          profile: { city: "Madrid" },
          retries: "5",
          dueAt: "2026-12-31T10:00:00.000Z",
          unknownField: "must-be-ignored",
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        name: "Luis",
        email: "luis@example.com",
        role: "user", // default aplicado
        profile: { city: "Madrid" },
        retries: 5, // coerce string → int
        dueAt: "2026-12-31T10:00:00.000Z",
      });
      expect(res.body.data.unknownField).toBeUndefined();
      expect(res.body.meta).toMatchObject({ apiVersion: "2.0.0" });
      expect(typeof res.body.meta.requestId).toBe("string");
      expect(typeof res.body.meta.timestamp).toBe("string");
      expect(typeof res.body.meta.durationMs).toBe("number");
    });

    it("devuelve 400 con errores agrupados por campo y meta", async () => {
      const res = await http()
        .post("/api/spike/body")
        .send({ name: "X", email: "not-an-email", profile: {} })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Validation error in request payload");
      expect(Array.isArray(res.body.errors.name)).toBe(true);
      expect(Array.isArray(res.body.errors.email)).toBe(true);
      expect(typeof res.body.errors["profile.city"]?.[0]).toBe("string");
      expect(res.body.meta.requestId).toBeDefined();
      expect(res.headers["content-type"]).toContain("application/json");
    });
  });

  describe("validación de query y param", () => {
    it("aplica defaults de query", async () => {
      const res = await http().get("/api/spike/query").expect(200);
      expect(res.body.data).toMatchObject({ page: 1, limit: 20 });
    });

    it("valida query inválida con 400 agrupado", async () => {
      const res = await http().get("/api/spike/query?page=0&limit=abc").expect(400);
      expect(res.body.errors.page).toBeDefined();
      expect(res.body.errors.limit).toBeDefined();
    });

    it("mantiene claves literales filter[...] (query parser simple)", async () => {
      const res = await http()
        .get("/api/spike/echo-query?filter[title]=hola&sort=-createdAt")
        .expect(200);
      expect(res.body.keys).toContain("filter[title]");
      expect(res.body.keys).toContain("sort");
      expect(res.body.keys).not.toContain("filter");
    });

    it("valida path params", async () => {
      await http().get("/api/spike/param/task-1").expect(200);
      const res = await http().get("/api/spike/param/bad%21").expect(400);
      expect(res.body.errors.id).toBeDefined();
    });
  });

  describe("serialización y envolvente", () => {
    it("@ZodResponse serializa antes de que el interceptor envuelva (orden)", async () => {
      const res = await http().get("/api/spike/items").expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([{ id: "item-1", title: "Demo" }]);
      expect(res.body.data[0].secret).toBeUndefined();
      expect(res.body.meta.apiVersion).toBe("2.0.0");
    });

    it("@TopLevelEnvelope extiende en nivel superior (login/refresh)", async () => {
      const res = await http()
        .post("/api/spike/toplevel")
        .send({ name: "Luis", email: "luis@example.com" })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("top-level ok");
      expect(res.body.token).toBe("fake-token");
      expect(res.body.data).toBeUndefined();
      expect(res.body.meta.requestId).toBeDefined();
    });

    it("@NoEnvelope devuelve el cuerpo tal cual", async () => {
      const res = await http().get("/api/spike/raw").expect(200);
      expect(res.body).toEqual({ plain: true, success: "NOT-ADDED" });
    });

    it("errores de dominio con errors agrupados (409)", async () => {
      const res = await http().get("/api/spike/conflict").expect(409);
      expect(res.body).toMatchObject({
        success: false,
        message: "Resource already exists",
        errors: { code: ["already_taken"] },
      });
      expect(res.body.meta.requestId).toBeDefined();
    });
  });

  describe("infraestructura HTTP", () => {
    it("JSON malformado → 400 con mensaje exacto del baseline", async () => {
      const res = await http()
        .post("/api/spike/body")
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
        .post("/api/spike/body")
        .send({ name: "x".repeat(100 * 1024 + 64) })
        .expect(413);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe(
        "Payload Too Large: Request body exceeds the maximum permitted limit of 100 KB.",
      );
    });

    it("eco de X-Request-Id válido y rechazo del inválido", async () => {
      const echoed = await http().get("/api/spike/raw").set("x-request-id", "contract-echo.42");
      expect(echoed.headers["x-request-id"]).toBe("contract-echo.42");

      const rejected = await http().get("/api/spike/raw").set("x-request-id", "bad id spaces!");
      expect(rejected.headers["x-request-id"]).not.toBe("bad id spaces!");
      expect(rejected.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("cabeceras de tiempo y de seguridad del baseline", async () => {
      const res = await http().get("/api/spike/raw").expect(200);
      expect(res.headers["x-response-time"]).toMatch(/^\d+(\.\d+)?ms$/);
      expect(res.headers["server-timing"]).toMatch(/total;dur=\d/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(res.headers["content-security-policy"]).toBeUndefined();
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

    it("GET / lista los endpoints del modo activo", async () => {
      const res = await http().get("/").expect(200);
      expect(res.body.status).toBe("online");
      expect(typeof res.body.name).toBe("string");
      expect(typeof res.body.version).toBe("string");
      expect(res.body.authMode).toBe("full");
      expect(res.body.endpoints.healthcheck).toBe("/healthz");
      expect(res.body.endpoints.auth.login).toBe("POST /api/auth/login");
      expect(res.body.endpoints.mfa.setup).toBe("POST /api/auth/mfa/setup");
      expect(res.body.endpoints.tasks).toBe("GET, POST, PUT, DELETE /api/tasks");
    });

    it("ruta inexistente → 404 con el mensaje exacto del baseline", async () => {
      const res = await http().get("/nonexistent").expect(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Route not found: GET /nonexistent");
      expect(res.body.meta.requestId).toBeDefined();
    });
  });

  describe("OpenAPI + Scalar", () => {
    it("/openapi.json es un documento OpenAPI 3 válido con BearerAuth y rutas spike", async () => {
      const res = await http().get("/openapi.json").expect(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(String(res.body.openapi)).toMatch(/^3\./);

      const doc = JSON.parse(JSON.stringify(res.body));
      await SwaggerParser.validate(doc); // lanza si el documento no valida

      expect(doc.components.securitySchemes.BearerAuth).toBeDefined();
      expect(doc.paths["/api/spike/body"]).toBeDefined();
      expect(doc.paths["/api/spike/items"]).toBeDefined();
      expect(doc.paths["/api/spike/param/{id}"]).toBeDefined();
      expect(doc.paths["/api/spike/items"].get.responses["200"]).toBeDefined();
      expect(doc.info.version).toBe("2.0.0");
    });

    it("/docs sirve HTML de Scalar", async () => {
      const res = await http().get("/docs").expect(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text.length).toBeGreaterThan(500);
    });
  });
});
