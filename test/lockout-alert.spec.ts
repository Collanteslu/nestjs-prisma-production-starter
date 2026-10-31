import { Logger } from "@nestjs/common";
import { parseEnv } from "../src/config/env";
import { LoginLockoutService } from "../src/rate-limit/login-lockout.service";
import type { RateLimitService } from "../src/rate-limit/rate-limit.service";

/**
 * Alert hook of the account lockout (audit finding): the WARN must fire exactly once per
 * engagement, derived from the count each hit itself returns, never from a separate read
 * that a concurrent failure can race.
 */
describe("LoginLockoutService alert hook", () => {
  const env = parseEnv({
    NODE_ENV: "test",
    AUTH_MODE: "full",
    JWT_SECRET: "a".repeat(48),
    JWT_REFRESH_SECRET: "b".repeat(48),
    LOGIN_LOCKOUT_MAX_FAILURES: "5",
    LOGIN_LOCKOUT_MINUTES: "15",
  });

  /** In-memory store: every hit returns the count it produced (like the atomic increment) */
  const buildStore = () => {
    const counts = new Map<string, number>();
    const resetAt = new Date(Date.now() + 15 * 60_000);
    return {
      hit: jest.fn(async (key: string) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { count, resetAt };
      }),
      slide: jest.fn(async () => undefined),
      peek: jest.fn(async (key: string) => {
        const count = counts.get(key);
        return count ? { count, resetAt } : null;
      }),
    } as unknown as RateLimitService & { hit: jest.Mock };
  };

  it("warns exactly once when the threshold is crossed, however many failures follow", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const lockout = new LoginLockoutService(buildStore(), env);
      for (let i = 0; i < 8; i++) {
        await lockout.recordFailure("victim@example.com");
      }
      const engaged = warn.mock.calls.filter((call) =>
        String(call[0]).includes("Account lockout engaged"),
      );
      expect(engaged).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn below the threshold", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const lockout = new LoginLockoutService(buildStore(), env);
      for (let i = 0; i < 4; i++) {
        await lockout.recordFailure("other@example.com");
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
