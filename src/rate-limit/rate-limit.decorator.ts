import { SetMetadata } from "@nestjs/common";
import type { Env } from "../config/env";

export const RATE_LIMIT_KEY = "rateLimit";

/**
 * Named rate limiters with the reference's windows/limits. The limits come from the
 * injected env at REQUEST time (decorators run at import time, where no config exists).
 */
export const RATE_LIMITS = {
  // Per-IP limits for the auth endpoints (name → window + env-backed max)
  login: { windowMs: 60_000, max: (env: Env) => env.LOGIN_RATE_LIMIT_MAX },
  refresh: { windowMs: 60_000, max: (env: Env) => env.REFRESH_RATE_LIMIT_MAX },
  register: { windowMs: 60 * 60_000, max: (env: Env) => env.REGISTER_RATE_LIMIT_MAX },
  // Per-IP limits for the recovery endpoints (per hour) and the MFA endpoints (per minute)
  recovery: { windowMs: 60 * 60_000, max: (env: Env) => env.RECOVERY_RATE_LIMIT_MAX },
  mfa: { windowMs: 60_000, max: (env: Env) => env.MFA_RATE_LIMIT_MAX },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Applies the named DB-backed rate limiter to a route (reference middleware parity). */
export const RateLimit = (name: RateLimitName) => SetMetadata(RATE_LIMIT_KEY, name);
