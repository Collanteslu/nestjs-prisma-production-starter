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
 * Trusting forwarded client IPs (audit item 3). The IP feeds the rate limits and the
 * audit trail, so the two deployment postures must be pinned by tests:
 *
 *  - DEFAULT (TRUST_PROXY unset): X-Forwarded-For from an arbitrary client is IGNORED —
 *    a client that reaches the API directly cannot spoof the address limits key on.
 *  - TRUST_PROXY enabled: the configured number of trusted hops is honoured (one hop in
 *    this test) — which is why the proxy must OVERWRITE/append the header and the API
 *    must only be reachable THROUGH the proxy (AGENTS.md, "Despliegue con proxy").
 */
describe("TRUST_PROXY: client IP resolution", () => {
  const FORGED = "198.51.100.77";
  let app: INestApplication;

  const boot = async (): Promise<INestApplication> => {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { encoding: "utf8", env: process.env });
    const env = loadEnv(); // reads the current process.env (TRUST_PROXY set per phase)
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    const instance = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(instance, env, featuresOf(env));
    await instance.init();
    const prisma = instance.get(PrismaService);
    await prisma.rateLimitBucket.deleteMany({});
    return instance;
  };

  afterAll(async () => {
    await app?.close();
    delete process.env.TRUST_PROXY;
  });

  /** Logs in a throwaway account and returns the IP recorded for its session */
  const loginIp = async (): Promise<string | null> => {
    const http = request(app.getHttpServer());
    const email = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await http
      .post("/api/auth/register")
      .set("X-Forwarded-For", FORGED)
      .send({ name: "Proxy Test", email, password: "Password123!" })
      .expect(201);
    const login = await http
      .post("/api/auth/login")
      .set("X-Forwarded-For", FORGED)
      .send({ email, password: "Password123!" })
      .expect(200);

    const prisma = app.get(PrismaService);
    const session = await prisma.session.findUnique({
      where: { id: login.body.sessionId as string },
      select: { ipAddress: true },
    });
    return session?.ipAddress ?? null;
  };

  it("ignores X-Forwarded-For by default (a direct client cannot spoof the limit key)", async () => {
    delete process.env.TRUST_PROXY;
    app = await boot();

    const ip = await loginIp();
    expect(ip).not.toBe(FORGED); // Express keeps the socket address
    expect(ip).toBeTruthy();
  });

  it("honours the trusted hop when TRUST_PROXY is enabled (the proxy's contract)", async () => {
    process.env.TRUST_PROXY = "true"; // TRUST_PROXY_HOPS defaults to 1
    await app?.close();
    app = await boot();

    const ip = await loginIp();
    expect(ip).toBe(FORGED); // the single configured hop is trusted
  });
});
