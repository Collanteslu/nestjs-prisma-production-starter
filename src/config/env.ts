import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { z } from "zod";

/**
 * Environment configuration: strict schema + fail-fast loading.
 *
 * Ported 1:1 from the reference implementation (Hono). Unlike the reference, nothing
 * reads `process.env` at import time: `loadEnv()`/`parseEnv()` produce a validated
 * object that is injected into the app (AppModule.forRoot), which keeps tests free of
 * module-load side effects and allows explicit overrides.
 */
export const envSchema = z
  .object({
    PORT: z.coerce.number().default(3011),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // Authentication level (see README "Authentication modes"):
    // - none : no users, no auth; only the public example resource (/api/tasks) is mounted
    // - basic: users, login, refresh-token sessions, roles and audit (no email, recovery or 2FA)
    // - full : basic + email verification, password recovery and TOTP two-factor auth (default)
    AUTH_MODE: z.enum(["none", "basic", "full"]).default("full"),
    // Signing secrets: required unless AUTH_MODE=none (checked below)
    JWT_SECRET: z
      .string()
      .min(16, "JWT_SECRET must contain at least 16 characters for cryptographic security")
      .optional(),
    JWT_REFRESH_SECRET: z
      .string()
      .min(16, "JWT_REFRESH_SECRET must contain at least 16 characters")
      .optional(),
    DATABASE_URL: z.string().default("file:./dev.db"),
    TURSO_DATABASE_URL: z.string().optional(),
    TURSO_AUTH_TOKEN: z.string().optional(),
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((val) => val === "true" || val === "1"),
    // Number of trusted reverse proxies in front of the API (1 = one proxy such as Traefik/Nginx;
    // 2 = e.g. Cloudflare + Traefik). Only used when TRUST_PROXY is enabled.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).max(72).optional(),
    // Comma-separated list of allowed CORS origins ("*" allows any origin). When unset it defaults to
    // "*" outside production and to no cross-origin access at all in production. (Default is filled
    // in the first transform, where NODE_ENV is available.)
    CORS_ORIGINS: z.string().optional(),
    // Expose /docs and /openapi.json (defaults to true outside production)
    ENABLE_DOCS: z
      .string()
      .optional()
      .transform((val) => (val === undefined ? undefined : val === "true" || val === "1")),
    // Explicit opt-in for a wildcard ("*") CORS origin. Rejected in production unless true.
    CORS_ALLOW_WILDCARD: z
      .string()
      .optional()
      .transform((val) => val === "true" || val === "1"),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    REFRESH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    // Per-IP limits for the recovery endpoints (per hour) and the MFA endpoints (per minute)
    RECOVERY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    MFA_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    // Failed passwords before an account is locked, and for how long
    LOGIN_LOCKOUT_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().positive().default(15),
    // Audit entries older than this many days are purged (0 keeps them forever)
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
    // --- Account recovery, email verification and two-factor authentication ---
    // "none" disables outgoing mail (default in production), "log" prints messages to the log
    // (default elsewhere, handy in development), "memory" keeps them in an array (tests only).
    // (Default is filled in the first transform, where NODE_ENV is available.)
    MAIL_TRANSPORT: z.enum(["none", "log", "smtp", "memory"]).optional(),
    SMTP_URL: z.string().optional(), // e.g. smtps://user:pass@smtp.example.com:465
    MAIL_FROM: z.string().default("NestJS API <no-reply@localhost>"),
    // Frontend base URL used to build the links sent by email (token is appended as ?token=...).
    // Defaults to http://localhost:3000, except in production with SMTP where it is required.
    APP_URL: z.string().url().optional(),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().positive().default(60),
    EMAIL_VERIFY_TTL_HOURS: z.coerce.number().positive().default(24),
    // When true, accounts must verify their email before they can sign in
    REQUIRE_EMAIL_VERIFICATION: z
      .string()
      .optional()
      .transform((val) => val === "true" || val === "1"),
    // Key encrypting TOTP secrets at rest (defaults to a key derived from JWT_SECRET).
    // Required in production with AUTH_MODE=full (see superRefine below).
    MFA_ENCRYPTION_KEY: z.string().min(32).optional(),
    // Previous encryption key: set it while rotating MFA_ENCRYPTION_KEY so already-enrolled
    // secrets keep decrypting; only used for decryption, never to encrypt new secrets.
    MFA_ENCRYPTION_KEY_PREVIOUS: z.string().min(32).optional(),
    MFA_ISSUER: z.string().default("NestJS API"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    // Seconds during which reusing a just-rotated refresh token is treated as a concurrent refresh
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(10),
    // What the rate limiter does when the database-backed counter store is unavailable:
    // "local" (default) keeps a temporary per-process window on the critical routes
    // (login, register, refresh, recovery and MFA) so a store outage cannot disable them;
    // "open" lets everything through (pure availability; the previous behaviour).
    RATE_LIMIT_ON_DB_FAILURE: z.enum(["local", "open"]).default("local"),
  })
  .transform((cfg) => ({
    ...cfg,
    CORS_ORIGINS: cfg.CORS_ORIGINS ?? (cfg.NODE_ENV === "production" ? "" : "*"),
    MAIL_TRANSPORT: cfg.MAIL_TRANSPORT ?? (cfg.NODE_ENV === "production" ? "none" : "log"),
  }))
  .transform((cfg) => ({
    ...cfg,
    CORS_ORIGINS: cfg.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  }))
  .superRefine((cfg, ctx) => {
    const authEnabled = cfg.AUTH_MODE !== "none";
    const fullAuth = cfg.AUTH_MODE === "full";

    if (authEnabled) {
      for (const key of ["JWT_SECRET", "JWT_REFRESH_SECRET"] as const) {
        if (!cfg[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required unless AUTH_MODE=none (generate one with: openssl rand -base64 48)`,
          });
        }
      }
    } else if (cfg.ADMIN_EMAIL || cfg.ADMIN_PASSWORD) {
      ctx.addIssue({
        code: "custom",
        path: ["ADMIN_EMAIL"],
        message:
          "ADMIN_EMAIL / ADMIN_PASSWORD have no effect with AUTH_MODE=none (there are no users)",
      });
    }
    if (cfg.REQUIRE_EMAIL_VERIFICATION && !fullAuth) {
      ctx.addIssue({
        code: "custom",
        path: ["REQUIRE_EMAIL_VERIFICATION"],
        message:
          "REQUIRE_EMAIL_VERIFICATION needs AUTH_MODE=full (email verification is off otherwise)",
      });
    }

    if (cfg.MAIL_TRANSPORT === "smtp" && !cfg.SMTP_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_URL"],
        message: "SMTP_URL is required when MAIL_TRANSPORT=smtp",
      });
    }
    if (
      cfg.REQUIRE_EMAIL_VERIFICATION &&
      (cfg.MAIL_TRANSPORT === "none" || cfg.MAIL_TRANSPORT === "log")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["REQUIRE_EMAIL_VERIFICATION"],
        message:
          "REQUIRE_EMAIL_VERIFICATION needs a mail transport that delivers (MAIL_TRANSPORT=smtp), otherwise nobody could verify",
      });
    }
    if (authEnabled && cfg.JWT_SECRET && cfg.JWT_SECRET === cfg.JWT_REFRESH_SECRET) {
      // Same secret in ANY environment: a refresh token would then verify as an access token
      // (both payloads carry userId and the access verifier only checks those claims)
      ctx.addIssue({
        code: "custom",
        path: ["JWT_REFRESH_SECRET"],
        message: "JWT_REFRESH_SECRET must differ from JWT_SECRET",
      });
    }
    if (cfg.MFA_ENCRYPTION_KEY_PREVIOUS && !cfg.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["MFA_ENCRYPTION_KEY_PREVIOUS"],
        message:
          "MFA_ENCRYPTION_KEY_PREVIOUS only works together with MFA_ENCRYPTION_KEY (it is the key being replaced during a rotation)",
      });
    }
    if (cfg.NODE_ENV !== "production") return;
    // Production hardening below
    if (cfg.MAIL_TRANSPORT === "memory") {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_TRANSPORT"],
        message: "MAIL_TRANSPORT=memory is for tests only",
      });
    }
    // Password-reset and verification links embed single-use credentials: the log stream is
    // often shipped to third parties and kept far longer than the process, so writing the
    // message there would leak live tokens (OWASP Logging Cheat Sheet: never log secrets).
    if (cfg.MAIL_TRANSPORT === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_TRANSPORT"],
        message:
          "MAIL_TRANSPORT=log is development-only: in production it would write password-reset and verification tokens to the log stream. Use MAIL_TRANSPORT=smtp.",
      });
    }
    // TLS is mandatory for SMTP in production: a valid smtp(s) URL, and no query option
    // able to weaken the channel (the transport additionally forces `requireTLS`, so a
    // server without STARTTLS fails to send instead of falling back to plaintext)
    if (cfg.MAIL_TRANSPORT === "smtp") {
      let smtpUrl: URL | undefined;
      try {
        smtpUrl = new URL(cfg.SMTP_URL ?? "");
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_URL"],
          message:
            "SMTP_URL must be a valid URL in production (e.g. smtps://user:pass@smtp.example.com:465)",
        });
      }
      if (smtpUrl && !["smtp:", "smtps:"].includes(smtpUrl.protocol)) {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_URL"],
          message: "SMTP_URL must use the smtp:// or smtps:// scheme",
        });
      }
      if (
        smtpUrl &&
        (smtpUrl.searchParams.get("ignoreTLS") === "true" ||
          smtpUrl.searchParams.get("rejectUnauthorized") === "false")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["SMTP_URL"],
          message:
            "SMTP_URL disables TLS verification (ignoreTLS/rejectUnauthorized): not allowed in production",
        });
      }
    }
    // Without a dedicated key the TOTP secrets are encrypted with a key derived from
    // JWT_SECRET: rotating the JWT secret would make every enrolled authenticator
    // undecryptable and lock users out of their 2FA (OWASP Secrets Management: keys need
    // an explicit lifecycle independent from signing secrets).
    if (fullAuth && !cfg.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["MFA_ENCRYPTION_KEY"],
        message:
          "MFA_ENCRYPTION_KEY (>= 32 chars) is required in production with AUTH_MODE=full so TOTP secrets are encrypted with a dedicated, stable key (generate one with: openssl rand -base64 48)",
      });
    }
    // A wildcard origin in production would expose the API to every site; require an
    // explicit, documented decision instead of inheriting the development default.
    if (cfg.CORS_ORIGINS.includes("*") && !cfg.CORS_ALLOW_WILDCARD) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message:
          'CORS_ORIGINS="*" is rejected in production: list the real origins, or set CORS_ALLOW_WILDCARD=true to allow any origin deliberately',
      });
    }
    // Real account emails must not point at the localhost default (or at a plain-http page)
    if (fullAuth && cfg.MAIL_TRANSPORT === "smtp") {
      if (!cfg.APP_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message:
            "APP_URL is required in production when MAIL_TRANSPORT=smtp (it builds the emailed links)",
        });
      } else if (new URL(cfg.APP_URL).protocol !== "https:") {
        ctx.addIssue({
          code: "custom",
          path: ["APP_URL"],
          message: "APP_URL must use https in production when MAIL_TRANSPORT=smtp",
        });
      }
    }
    // Refuse weak or shared signing secrets
    if (!authEnabled) return;
    for (const key of ["JWT_SECRET", "JWT_REFRESH_SECRET"] as const) {
      if ((cfg[key] ?? "").length < 32) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must contain at least 32 characters in production (generate one with: openssl rand -base64 48)`,
        });
      }
    }
  })
  .transform((cfg) => ({
    ...cfg,
    APP_URL: cfg.APP_URL ?? "http://localhost:3000",
    // Only reachable without a secret when AUTH_MODE=none, where nothing signs or verifies tokens:
    // a random per-process value guarantees no guessable key could ever be used by mistake.
    JWT_SECRET: cfg.JWT_SECRET ?? randomBytes(48).toString("base64"),
    JWT_REFRESH_SECRET: cfg.JWT_REFRESH_SECRET ?? randomBytes(48).toString("base64"),
  }));

export type Env = z.infer<typeof envSchema>;

/** Which optional modules are active for the configured AUTH_MODE */
export type Features = {
  /** Users, login, sessions, roles, audit log (AUTH_MODE=basic or full) */
  auth: boolean;
  /** Email verification, password recovery and TOTP 2FA (AUTH_MODE=full) */
  accountSecurity: boolean;
};

export function featuresOf(env: Env): Features {
  return {
    auth: env.AUTH_MODE !== "none",
    accountSecurity: env.AUTH_MODE === "full",
  };
}

/** Raised by parseEnv(); carries the same flattened field errors the reference prints. */
export class EnvValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[]>) {
    super("Invalid or missing environment configuration");
    this.name = "EnvValidationError";
  }
}

/**
 * Validates a raw environment (empty strings are treated as unset, like docker-compose defaults).
 * Throws EnvValidationError instead of exiting, so tests can assert on it.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const rawEnv = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    throw new EnvValidationError(z.flattenError(parsed.error).fieldErrors);
  }
  return parsed.data;
}

let dotenvLoaded = false;

/** Loads `.env` and validates `process.env`, failing fast at startup like the reference. */
export function loadEnv(): Env {
  if (!dotenvLoaded) {
    dotenv.config({ quiet: true });
    dotenvLoaded = true;
  }
  try {
    return parseEnv(process.env);
  } catch (err) {
    console.error("❌ Critical startup failure: Invalid or missing environment configuration:");
    if (err instanceof EnvValidationError) {
      console.error(JSON.stringify(err.fieldErrors, null, 2));
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}
