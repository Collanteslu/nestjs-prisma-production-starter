import "reflect-metadata";
import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { AppModule } from "../src/app.module";
import type { JwtAuthGuard } from "../src/auth/jwt-auth.guard";
import { configureApp } from "../src/configure-app";
import { featuresOf, parseEnv } from "../src/config/env";
import type { Features } from "../src/config/env";
import { PrismaService } from "../src/database/prisma.service";
import { AuthPrefixMiddleware } from "../src/common/middleware/auth-prefix.middleware";

/**
 * AuthPrefixMiddleware makes authentication apply to a protected prefix AND all of its
 * sub-paths, so an unauthenticated probe of a path that no route matches answers 401 instead
 * of leaking a 404 (a global Nest guard only runs on matched routes). Unit tests pin the
 * middleware's own contract; the integration block pins the observable behaviour through
 * the real router for both auth modes.
 */
describe("AuthPrefixMiddleware (unit)", () => {
  const featuresFor = (auth: boolean): Features => ({ auth, accountSecurity: false });
  const build = (auth: boolean, authenticate: jest.Mock) =>
    new AuthPrefixMiddleware({ authenticate } as unknown as JwtAuthGuard, featuresFor(auth));
  const req = { headers: {} } as Request;
  const res = {} as Response;

  it("is a no-op when authentication is not mounted (AUTH_MODE=none)", async () => {
    const authenticate = jest.fn();
    const next = jest.fn() as NextFunction;
    await build(false, authenticate).use(req, res, next);
    expect(authenticate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("authenticates the request and then continues", async () => {
    const authenticate = jest.fn().mockResolvedValue({ userId: "u1" });
    const next = jest.fn() as NextFunction;
    await build(true, authenticate).use(req, res, next);
    expect(authenticate).toHaveBeenCalledWith(req);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects without calling next() when authentication fails", async () => {
    const authenticate = jest.fn().mockRejectedValue(new UnauthorizedException("nope"));
    const next = jest.fn() as NextFunction;
    await expect(build(true, authenticate).use(req, res, next)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe("AuthPrefixMiddleware (through the router)", () => {
  const protectedPrefixes = ["/api/sessions", "/api/users", "/api/tasks", "/api/audit-logs"];
  let withAuth: INestApplication;
  let noAuth: INestApplication;
  let token: string;

  async function boot(authMode: "full" | "none"): Promise<INestApplication> {
    const env = parseEnv({ ...process.env, AUTH_MODE: authMode });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app, env, featuresOf(env));
    await app.init();
    return app;
  }

  beforeAll(async () => {
    // Fresh machines (and CI) start with an empty tmp database
    execFileSync("npx", ["prisma", "migrate", "deploy"], { encoding: "utf8", env: process.env });
    withAuth = await boot("full");
    noAuth = await boot("none");
    await withAuth.get(PrismaService).rateLimitBucket.deleteMany({});

    const email = `prefix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const password = "Password123!";
    await request(withAuth.getHttpServer())
      .post("/api/auth/register")
      .send({ name: "Prefix User", email, password })
      .expect(201);
    const login = await request(withAuth.getHttpServer())
      .post("/api/auth/login")
      .send({ email, password })
      .expect(200);
    token = login.body.accessToken;
  }, 60_000);

  afterAll(async () => {
    await withAuth?.close();
    await noAuth?.close();
  });

  it.each(protectedPrefixes)("%s and unmounted sub-paths answer 401 without a token", async (p) => {
    for (const path of [p, `${p}/unknown`, `${p}/a/b/c`]) {
      const res = await request(withAuth.getHttpServer()).get(path);
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it("answers 401 (not 404) for every HTTP method on an unmounted sub-path", async () => {
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(withAuth.getHttpServer())[method]("/api/users/unknown/deep");
      expect([method, res.status]).toEqual([method, 401]);
    }
  });

  it("rejects an invalid token on a sub-path with 401", async () => {
    const res = await request(withAuth.getHttpServer())
      .get("/api/tasks/unknown/deep")
      .set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
  });

  it("reaches the router (404) once authenticated", async () => {
    for (const p of protectedPrefixes) {
      const res = await request(withAuth.getHttpServer())
        .get(`${p}/unknown/deep`)
        .set("Authorization", `Bearer ${token}`);
      expect([p, res.status]).toEqual([p, 404]);
    }
  });

  it("does not guard paths outside the protected prefixes", async () => {
    const unknown = await request(withAuth.getHttpServer()).get("/api/unknown/deep");
    expect(unknown.status).toBe(404);
    const health = await request(withAuth.getHttpServer()).get("/healthz");
    expect(health.status).toBe(200);
  });

  it("is a no-op with AUTH_MODE=none: no token is demanded, tasks are public", async () => {
    const tasks = await request(noAuth.getHttpServer()).get("/api/tasks");
    expect(tasks.status).toBe(200);
    const unknown = await request(noAuth.getHttpServer()).get("/api/tasks/unknown/deep");
    expect(unknown.status).toBe(404);
    const users = await request(noAuth.getHttpServer()).get("/api/users/unknown/deep");
    expect(users.status).toBe(404);
  });
});
