import { parseEnv, featuresOf, docsEnabled } from "../src/config/env";
import { SystemController } from "../src/system/system.controller";

const base = {
  JWT_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "b".repeat(48),
  MAIL_TRANSPORT: "none",
  DATABASE_URL: "file:./unused.db",
  MFA_ENCRYPTION_KEY: "c".repeat(48),
};

function overview(extra: Record<string, string>): Record<string, unknown> {
  const env = parseEnv({ ...base, ...extra });
  return new SystemController(env, featuresOf(env)).index();
}

describe("GET / only advertises /docs when the documentation is served", () => {
  it("links to /docs outside production", () => {
    const body = overview({ NODE_ENV: "development" });
    expect(body.documentationUrl).toBe("/docs");
    expect((body.endpoints as Record<string, unknown>).documentation).toBe("/docs");
  });

  it("does not advertise /docs in production (docs are off by default there)", () => {
    const body = overview({ NODE_ENV: "production" });
    expect(body).not.toHaveProperty("documentationUrl");
    expect(body.endpoints).not.toHaveProperty("documentation");
    expect((body.endpoints as Record<string, unknown>).healthcheck).toBe("/healthz");
  });

  it("advertises /docs in production when ENABLE_DOCS=true", () => {
    const body = overview({ NODE_ENV: "production", ENABLE_DOCS: "true" });
    expect(body.documentationUrl).toBe("/docs");
  });

  it("docsEnabled follows the same rule", () => {
    expect(docsEnabled(parseEnv({ ...base, NODE_ENV: "production" }))).toBe(false);
    expect(docsEnabled(parseEnv({ ...base, NODE_ENV: "test" }))).toBe(true);
  });
});
