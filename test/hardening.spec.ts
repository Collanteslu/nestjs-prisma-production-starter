import "reflect-metadata";
import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { featuresOf, loadEnv, parseEnv } from "../src/config/env";
import { PrismaService } from "../src/database/prisma.service";
import { TotpService } from "../src/mfa/totp.service";

/** Regression tests for the security review fixes (demo seed, session cap, MFA disable lockout). */
describe("hardening regressions", () => {
  describe("SEED_DEMO and MAX_ACTIVE_SESSIONS configuration", () => {
    it("defaults to no demo seed and a cap of 20 active sessions", () => {
      const env = parseEnv({
        AUTH_MODE: "full",
        JWT_SECRET: "x".repeat(32),
        JWT_REFRESH_SECRET: "y".repeat(32),
      });
      expect(env.SEED_DEMO).toBe(false);
      expect(env.MAX_ACTIVE_SESSIONS).toBe(20);
    });

    it("rejects SEED_DEMO=true in production", () => {
      expect(() =>
        parseEnv({
          NODE_ENV: "production",
          AUTH_MODE: "basic",
          SEED_DEMO: "true",
          JWT_SECRET: "x".repeat(40),
          JWT_REFRESH_SECRET: "y".repeat(40),
        }),
      ).toThrow();
    });
  });

  describe("over HTTP", () => {
    let app: INestApplication;
    const http = () => request(app.getHttpServer());
    const previous = { MAX_ACTIVE_SESSIONS: process.env.MAX_ACTIVE_SESSIONS };

    beforeAll(async () => {
      process.env.MAX_ACTIVE_SESSIONS = "3";
      execFileSync("npx", ["prisma", "migrate", "deploy"], { encoding: "utf8", env: process.env });
      const env = loadEnv();
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.forRoot(env)],
      }).compile();
      app = moduleRef.createNestApplication({ bodyParser: false });
      await configureApp(app, env, featuresOf(env));
      await app.init();
      await app.get(PrismaService).rateLimitBucket.deleteMany({});
    }, 60_000);

    afterAll(async () => {
      if (previous.MAX_ACTIVE_SESSIONS === undefined) delete process.env.MAX_ACTIVE_SESSIONS;
      else process.env.MAX_ACTIVE_SESSIONS = previous.MAX_ACTIVE_SESSIONS;
      await app.close();
    });

    const uniqueEmail = () =>
      `hard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    it("revokes the oldest sessions beyond MAX_ACTIVE_SESSIONS on login", async () => {
      const email = uniqueEmail();
      const password = "Password123!";
      await http()
        .post("/api/auth/register")
        .send({ name: "Session Cap", email, password })
        .expect(201);

      const logins: string[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await http().post("/api/auth/login").send({ email, password }).expect(200);
        logins.push(res.body.sessionId);
      }

      const prisma = app.get(PrismaService);
      const active = await prisma.session.findMany({
        where: { user: { email }, isActive: true },
        select: { id: true },
      });
      expect(active).toHaveLength(3);
      // The first (oldest) session is the one revoked; the newest ones stay usable
      const oldest = await prisma.session.findUnique({ where: { id: logins[0] } });
      expect(oldest).toBeNull();
      const newest = await prisma.session.findUnique({ where: { id: logins[3] } });
      expect(newest?.isActive).toBe(true);
    });

    it("counts wrong second factors in MFA disable against the account lockout", async () => {
      const email = uniqueEmail();
      const password = "Password123!";
      await http()
        .post("/api/auth/register")
        .send({ name: "Mfa Lock", email, password })
        .expect(201);
      const login = await http().post("/api/auth/login").send({ email, password }).expect(200);
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };

      const setup = await http()
        .post("/api/auth/mfa/setup")
        .set(auth)
        .send({ currentPassword: password })
        .expect(200);
      const totp = app.get(TotpService);
      await http()
        .post("/api/auth/mfa/enable")
        .set(auth)
        .send({ code: totp.totpCode(setup.body.data.secret) })
        .expect(200);

      // Wrong second factor with the right password: rejected and counted
      for (let i = 0; i < 5; i++) {
        await http()
          .post("/api/auth/mfa/disable")
          .set(auth)
          .send({ currentPassword: password, code: "000000" })
          .expect(403);
      }
      // Lockout engaged: even the correct code is refused until the window ends
      const locked = await http()
        .post("/api/auth/mfa/disable")
        .set(auth)
        .send({ currentPassword: password, code: totp.totpCode(setup.body.data.secret) });
      expect(locked.status).toBe(429);
    });
  });
});
