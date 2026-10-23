import { EnvValidationError, parseEnv } from "../src/config/env";

/**
 * Startup guards added by the security review: production must refuse configurations that
 * leak credentials or weaken the perimeter, and cross-field misconfigurations must fail
 * fast with a readable message instead of booting into a broken state.
 */
describe("env guards (fail-fast configuration)", () => {
  const production = {
    NODE_ENV: "production",
    JWT_SECRET: "a".repeat(48),
    JWT_REFRESH_SECRET: "b".repeat(48),
  };

  const expectRejected = (env: NodeJS.ProcessEnv, field: string, match?: RegExp) => {
    let error: unknown;
    try {
      parseEnv(env);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const messages = (error as EnvValidationError).fieldErrors[field] ?? [];
    expect(messages.length).toBeGreaterThan(0);
    if (match) expect(messages.join(" ")).toMatch(match);
  };

  describe("item 1: MAIL_TRANSPORT=log never reaches production logs", () => {
    it("rejects MAIL_TRANSPORT=log in production (tokens would land in the log stream)", () => {
      expectRejected(
        { ...production, MAIL_TRANSPORT: "log" },
        "MAIL_TRANSPORT",
        /development-only.*log stream|log stream/s,
      );
    });

    it("still allows the development mailbox outside production", () => {
      const env = parseEnv({
        NODE_ENV: "development",
        MAIL_TRANSPORT: "log",
        JWT_SECRET: "dev-secret-0123456789",
        JWT_REFRESH_SECRET: "dev-refresh-abcdef0123",
      });
      expect(env.MAIL_TRANSPORT).toBe("log");
    });
  });

  describe("item 2: dedicated MFA key required in production with AUTH_MODE=full", () => {
    it("rejects production + full without MFA_ENCRYPTION_KEY", () => {
      expectRejected({ ...production }, "MFA_ENCRYPTION_KEY", /dedicated, stable key/);
    });

    it("accepts production + full with a dedicated key", () => {
      const env = parseEnv({ ...production, MFA_ENCRYPTION_KEY: "k".repeat(40) });
      expect(env.MFA_ENCRYPTION_KEY).toHaveLength(40);
    });

    it("does not require the key when AUTH_MODE=basic (no TOTP flows)", () => {
      expect(parseEnv({ ...production, AUTH_MODE: "basic" }).MFA_ENCRYPTION_KEY).toBeUndefined();
    });

    it("rejects a previous rotation key without a current key", () => {
      expectRejected(
        { ...production, MFA_ENCRYPTION_KEY_PREVIOUS: "p".repeat(40), AUTH_MODE: "basic" },
        "MFA_ENCRYPTION_KEY_PREVIOUS",
        /only works together/,
      );
    });
  });

  describe("item 15: wildcard CORS needs an explicit opt-in in production", () => {
    it('rejects CORS_ORIGINS="*" in production by default', () => {
      expectRejected(
        { ...production, MFA_ENCRYPTION_KEY: "k".repeat(40), CORS_ORIGINS: "*" },
        "CORS_ORIGINS",
        /CORS_ALLOW_WILDCARD/,
      );
    });

    it('accepts CORS_ORIGINS="*" with CORS_ALLOW_WILDCARD=true', () => {
      const env = parseEnv({
        ...production,
        MFA_ENCRYPTION_KEY: "k".repeat(40),
        CORS_ORIGINS: "*",
        CORS_ALLOW_WILDCARD: "true",
      });
      expect(env.CORS_ORIGINS).toEqual(["*"]);
      expect(env.CORS_ALLOW_WILDCARD).toBe(true);
    });

    it('accepts an explicit origin list without the opt-in', () => {
      const env = parseEnv({
        ...production,
        MFA_ENCRYPTION_KEY: "k".repeat(40),
        CORS_ORIGINS: "https://app.example.com",
      });
      expect(env.CORS_ORIGINS).toEqual(["https://app.example.com"]);
    });
  });

  describe("regression: pre-existing production guards still hold", () => {
    it("rejects MAIL_TRANSPORT=memory in production", () => {
      expectRejected({ ...production, MAIL_TRANSPORT: "memory" }, "MAIL_TRANSPORT");
    });

    it("rejects JWT secrets shorter than 32 chars in production", () => {
      expectRejected(
        { ...production, JWT_SECRET: "short", JWT_REFRESH_SECRET: "b".repeat(48) },
        "JWT_SECRET",
      );
    });

    it("rejects identical access and refresh secrets", () => {
      expectRejected(
        { ...production, JWT_REFRESH_SECRET: production.JWT_SECRET },
        "JWT_REFRESH_SECRET",
        /must differ/,
      );
    });
  });
});
