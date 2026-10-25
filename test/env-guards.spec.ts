import { EnvValidationError, parseEnv } from "../src/config/env";
import { smtpTransportConfig } from "../src/mail/mail.service";

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

    it("accepts an explicit origin list without the opt-in", () => {
      const env = parseEnv({
        ...production,
        MFA_ENCRYPTION_KEY: "k".repeat(40),
        CORS_ORIGINS: "https://app.example.com",
      });
      expect(env.CORS_ORIGINS).toEqual(["https://app.example.com"]);
    });
  });

  describe("SMTP requires TLS in production (step 1)", () => {
    const withSmtp = (url: string) => ({
      ...production,
      AUTH_MODE: "basic", // no APP_URL requirement; the URL rules apply to any mode
      MAIL_TRANSPORT: "smtp",
      SMTP_URL: url,
    });

    it("accepts implicit TLS (smtps://) and plain submission (smtp://, forced to upgrade)", () => {
      expect(parseEnv(withSmtp("smtps://user:pass@mail.example.com:465")).MAIL_TRANSPORT).toBe(
        "smtp",
      );
      expect(parseEnv(withSmtp("smtp://mail.example.com:587")).MAIL_TRANSPORT).toBe("smtp");
    });

    it("rejects URLs that disable TLS verification", () => {
      expectRejected(
        withSmtp("smtp://mail.example.com:587?ignoreTLS=true"),
        "SMTP_URL",
        /disables TLS verification/,
      );
      expectRejected(
        withSmtp("smtps://mail.example.com:465?rejectUnauthorized=false"),
        "SMTP_URL",
        /disables TLS verification/,
      );
    });

    it("rejects a non-SMTP scheme or a malformed URL", () => {
      expectRejected(withSmtp("http://mail.example.com:25"), "SMTP_URL", /smtp:\/\/ or smtps:\/\//);
      expectRejected(withSmtp("not a url"), "SMTP_URL", /valid URL/);
    });

    it("forces requireTLS only in production (local plaintext sinks keep working)", () => {
      expect(smtpTransportConfig(parseEnv(withSmtp("smtp://127.0.0.1:2525")))).toEqual({
        url: "smtp://127.0.0.1:2525",
        requireTLS: true,
      });
      const dev = parseEnv({
        NODE_ENV: "development",
        AUTH_MODE: "none",
        MAIL_TRANSPORT: "smtp",
        SMTP_URL: "smtp://127.0.0.1:2525",
      });
      expect(smtpTransportConfig(dev)).toEqual({ url: "smtp://127.0.0.1:2525" }); // no TLS forced
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
