import { SetMetadata } from "@nestjs/common";
import type { Env } from "../config/env";

export const RATE_LIMIT_KEY = "rateLimit";

/**
 * Named rate limiters with the Hono starter's windows/limits. The limits come from the
 * injected env at REQUEST time (decorators run at import time, where no config exists).
 */
export const RATE_LIMITS = {
  // Per-IP limits for the auth endpoints (name → window + env-backed max)
  login: { windowMs: 60_000, max: (env: Env) => env.LOGIN_RATE_LIMIT_MAX },
  refresh: { windowMs: 60_000, max: (env: Env) => env.REFRESH_RATE_LIMIT_MAX },
  // Logout only costs one indexed lookup, but it must not be hammerable either
  logout: { windowMs: 60_000, max: (env: Env) => env.LOGOUT_RATE_LIMIT_MAX },
  register: { windowMs: 60 * 60_000, max: (env: Env) => env.REGISTER_RATE_LIMIT_MAX },
  // Per-IP limits for the recovery endpoints (per hour) and the MFA endpoints (per minute)
  "forgot-password": { windowMs: 60 * 60_000, max: (env: Env) => env.RECOVERY_RATE_LIMIT_MAX },
  "reset-password": { windowMs: 60 * 60_000, max: (env: Env) => env.RECOVERY_RATE_LIMIT_MAX * 2 },
  "resend-verification": {
    windowMs: 60 * 60_000,
    max: (env: Env) => env.RECOVERY_RATE_LIMIT_MAX,
  },
  "verify-email": { windowMs: 60 * 60_000, max: (env: Env) => env.RECOVERY_RATE_LIMIT_MAX * 3 },
  mfa: { windowMs: 60_000, max: (env: Env) => env.MFA_RATE_LIMIT_MAX },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * Rates whose protection must survive an outage of the counter store when
 * RATE_LIMIT_ON_DB_FAILURE=local (the default): authentication, recovery and MFA are the
 * credential-stuffing/token-guessing surface — failing open there during an incident would
 * silently disable the protection exactly when the system is under stress.
 */
export const CRITICAL_RATE_LIMITS = new Set<RateLimitName>([
  "login",
  "refresh",
  "register",
  "forgot-password",
  "reset-password",
  "resend-verification",
  "verify-email",
  "mfa",
]);

/** Applies the named DB-backed rate limiter to a route (Hono middleware parity). */
export const RateLimit = (name: RateLimitName) => SetMetadata(RATE_LIMIT_KEY, name);
