import { parseEnv } from "../src/config/env";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "../src/rate-limit/rate-limit.guard";
import type { RateLimitService } from "../src/rate-limit/rate-limit.service";
import { LoginLockoutService } from "../src/rate-limit/login-lockout.service";
import { RateLimitedException } from "../src/common/exceptions/retry-after.exception";

/**
 * Store-outage behaviour of the rate limiter (audit item 5) and the account-lockout
 * alerting (item 4): with RATE_LIMIT_ON_DB_FAILURE=local (default) the critical routes
 * keep an in-process window while the shared store is down, every failure is counted as a
 * metric, and the engagement of a lockout is logged exactly once as a warning.
 */

const brokenStore = () =>
  ({
    hit: jest.fn().mockRejectedValue(new Error("sqlite unavailable")),
    peek: jest.fn(),
    slide: jest.fn(),
    clear: jest.fn(),
  }) as unknown as RateLimitService & { hit: jest.Mock };

function fakeContext(ip = "203.0.113.7") {
  const headers: Record<string, string> = {};
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

const reflectorFor = (name: string) => ({ getAllAndOverride: () => name }) as unknown as Reflector;

describe("RateLimitGuard: store outage", () => {
  it("keeps enforcing the critical limits from a local window (default mode)", async () => {
    const env = parseEnv({ AUTH_MODE: "none" }); // RATE_LIMIT_ON_DB_FAILURE defaults to "local"
    const guard = new RateLimitGuard(reflectorFor("login"), brokenStore(), env);
    const { ctx, headers } = fakeContext();

    // LOGIN_RATE_LIMIT_MAX defaults to 10 per minute
    for (let i = 0; i < 10; i++) {
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(RateLimitedException);

    expect(headers["X-RateLimit-Limit"]).toBe("10");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(guard.metrics.storeFailures).toBe(11);
    expect(guard.metrics.localBlocked).toBe(1);
  });

  it("counts every decision as a metric and isolates IPs in the local window", async () => {
    const env = parseEnv({ AUTH_MODE: "none" });
    const guard = new RateLimitGuard(reflectorFor("login"), brokenStore(), env);

    const first = fakeContext("198.51.100.1");
    for (let i = 0; i < 10; i++) await guard.canActivate(first.ctx);
    await expect(guard.canActivate(first.ctx)).rejects.toBeInstanceOf(RateLimitedException);

    // A different IP still gets its own window while the shared store is down
    const second = fakeContext("198.51.100.2");
    await expect(guard.canActivate(second.ctx)).resolves.toBe(true);

    expect(guard.metrics.localAllowed).toBe(11);
    expect(guard.metrics.localBlocked).toBe(1);
    expect(guard.metrics.storeFailures).toBe(12);
  });

  it("fails open everywhere when RATE_LIMIT_ON_DB_FAILURE=open (availability mode)", async () => {
    const env = parseEnv({ AUTH_MODE: "none", RATE_LIMIT_ON_DB_FAILURE: "open" });
    const guard = new RateLimitGuard(reflectorFor("login"), brokenStore(), env);
    const { ctx } = fakeContext();

    for (let i = 0; i < 50; i++) {
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    expect(guard.metrics.openAllowed).toBe(50);
    expect(guard.metrics.storeFailures).toBe(50);
    expect(guard.metrics.localBlocked).toBe(0);
  });

  it("routes without a rate name never touch the store", async () => {
    const store = brokenStore();
    const env = parseEnv({ AUTH_MODE: "none" });
    const guard = new RateLimitGuard(reflectorFor(undefined as unknown as string), store, env);
    await expect(guard.canActivate(fakeContext().ctx)).resolves.toBe(true);
    expect(store.hit).not.toHaveBeenCalled();
  });
});

describe("LoginLockoutService: engagement alert (item 4)", () => {
  const buildStore = () => {
    const counts = new Map<string, number>();
    const store = {
      hit: jest.fn(async (key: string) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { count: counts.get(key)!, resetAt: new Date(Date.now() + 60_000) };
      }),
      slide: jest.fn(async () => undefined),
      peek: jest.fn(async (key: string) =>
        counts.has(key)
          ? { count: counts.get(key)!, resetAt: new Date(Date.now() + 60_000) }
          : null,
      ),
      clear: jest.fn(async (key: string) => {
        counts.delete(key);
      }),
    };
    return store as unknown as RateLimitService;
  };

  it("logs one warning exactly when the account crosses the threshold", async () => {
    const env = parseEnv({ AUTH_MODE: "none" }); // LOGIN_LOCKOUT_MAX_FAILURES=5
    const service = new LoginLockoutService(buildStore(), env);
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
      "warn",
    );

    for (let i = 0; i < 4; i++) await service.recordFailure("victim@example.com");
    expect(warn).not.toHaveBeenCalled();

    await service.recordFailure("victim@example.com"); // 5th failure: lockout engages
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Account lockout engaged");
    // The raw address must never reach the log line
    expect(warn.mock.calls[0]?.[0]).not.toContain("victim@example.com");

    await expect(service.retryAfterSeconds("victim@example.com")).resolves.toBeGreaterThan(0);
    await service.reset("victim@example.com");
    await expect(service.retryAfterSeconds("victim@example.com")).resolves.toBe(0);
  });

  it("keys the bucket with a pseudonym, not the raw account", async () => {
    const env = parseEnv({ AUTH_MODE: "none" });
    const store = buildStore();
    const service = new LoginLockoutService(store, env);
    await service.recordFailure("someone@example.com");

    const keys = (store as unknown as { hit: jest.Mock }).hit.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("lockout:")).toBe(true);
      expect(key).not.toContain("someone@example.com");
    }
  });
});
