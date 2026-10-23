import "reflect-metadata";
import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { featuresOf, loadEnv } from "../src/config/env";
import { PrismaService } from "../src/database/prisma.service";

/**
 * Concurrency of the security-critical paths (audit item 14): token rotation must have
 * exactly one winner under simultaneous refreshes, session revocation must win over a
 * refresh racing with it, and the database-backed rate limiter must admit exactly `max`
 * requests when they all arrive at once (atomic increments, no lost updates).
 */
describe("concurrency: rotation, revocation and rate limits", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  const account = (tag: string) => ({
    name: `Concurrency ${tag}`,
    email: `conc-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "Password123!",
  });

  const register = async (tag: string) => {
    const creds = account(tag);
    await http().post("/api/auth/register").send(creds).expect(201);
    return creds;
  };

  const login = async (creds: { email: string; password: string }) => {
    const res = await http().post("/api/auth/login").send(creds).expect(200);
    return res.body as {
      accessToken: string;
      refreshToken: string;
      sessionId: string;
    };
  };

  beforeAll(async () => {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { encoding: "utf8", env: process.env });
    const env = loadEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app, env, featuresOf(env));
    await app.init();
    prisma = app.get(PrismaService);
    // The test database (and its rate-limit buckets) is shared across suites
    await prisma.rateLimitBucket.deleteMany({});
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it("simultaneous refreshes with the same token: exactly one rotation wins", async () => {
    const creds = await register("refresh");
    const tokens = await login(creds);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http().post("/api/auth/refresh").send({ refreshToken: tokens.refreshToken }),
      ),
    );

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    for (const res of results) {
      if (res.status !== 200) {
        // Within the reuse grace window a replayed rotation is a 409, never a second mint
        expect([401, 409]).toContain(res.status);
      }
    }
    // The winner got a fresh pair; the original refresh token is spent
    expect(winners[0]?.body.refreshToken).toEqual(expect.any(String));
    expect(winners[0]?.body.refreshToken).not.toBe(tokens.refreshToken);
  });

  it("session revocation wins over a refresh racing with it", async () => {
    const creds = await register("revoke");
    const tokens = await login(creds);

    const [revokeRes, refreshRes] = await Promise.all([
      http()
        .post("/api/sessions/revoke-all")
        .set("Authorization", `Bearer ${tokens.accessToken}`),
      http().post("/api/auth/refresh").send({ refreshToken: tokens.refreshToken }),
    ]);
    // Whichever order they interleaved in, both are legitimate outcomes of the race…
    expect([200, 401]).toContain(revokeRes.status);
    expect([200, 401]).toContain(refreshRes.status);

    // …but the final state is fixed: the account has no live session, so no token works
    const refreshedAccess =
      refreshRes.status === 200 ? (refreshRes.body.accessToken as string) : tokens.accessToken;
    await http()
      .get("/api/sessions/me")
      .set("Authorization", `Bearer ${refreshedAccess}`)
      .expect(401);
    await http()
      .post("/api/auth/refresh")
      .send({ refreshToken: tokens.refreshToken })
      .expect(401); // its session is gone: reuse outside any grace resolves to revocation
  });

  it("parallel requests count atomically: exactly `max` are admitted", async () => {
    // Fresh budget for this suite (REGISTER_RATE_LIMIT_MAX defaults to 5 per hour/IP)
    await prisma.rateLimitBucket.deleteMany({});

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        http()
          .post("/api/auth/register")
          .send({
            name: `Flood ${i}`,
            email: `flood-${Date.now()}-${i}@example.com`,
            password: "Password123!",
          }),
      ),
    );

    const admitted = results.filter((r) => r.status === 201);
    const throttled = results.filter((r) => r.status === 429);
    expect(admitted).toHaveLength(5); // no lost updates, no over-admission
    expect(throttled).toHaveLength(3);
    for (const res of throttled) {
      expect(res.headers["retry-after"]).toBeDefined();
      expect(res.body.message).toMatch(/Too many requests/i);
    }
  });
});
