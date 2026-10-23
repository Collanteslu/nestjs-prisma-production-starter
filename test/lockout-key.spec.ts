import { execFileSync } from "node:child_process";
import path from "node:path";
import { pseudonym } from "../src/common/utils/pii";

/**
 * The support tool (scripts/lockout-key.mjs) must produce EXACTLY the key the running
 * app writes for a lockout — otherwise operators would clear the wrong row. Pins the
 * tool to src/common/utils/pii.ts (item 4's recovery path).
 */
describe("scripts/lockout-key.mjs", () => {
  const script = path.join(__dirname, "..", "scripts", "lockout-key.mjs");
  const withPath = { ...process.env, PATH: process.env.PATH };

  const run = (email: string, secret: string): string =>
    execFileSync("node", [script, email], {
      encoding: "utf8",
      env: { ...withPath, JWT_SECRET: secret },
    });

  it("derives the same bucket key as the application's pseudonym()", () => {
    const secret = "test-secret-for-pseudonym-parity-0123456789";
    const out = run("  Ana@Example.COM ", secret);
    expect(out).toContain(`bucket : lockout:${pseudonym(secret, "Ana@Example.COM")}`);
    expect(out).toContain("SELECT count, resetAt FROM RateLimitBucket");
    expect(out).toContain("DELETE FROM RateLimitBucket");
    // The case/whitespace normalization must match the app (pseudonym trims + lowercases)
    expect(out).toContain(`lockout:${pseudonym(secret, "ana@example.com")}`);
  });

  it("fails fast without an email or without JWT_SECRET", () => {
    expect(() => execFileSync("node", [script], { encoding: "utf8", env: withPath })).toThrow();
    // setup-env inyecta JWT_SECRET en process.env: hay que quitarlo para probar el caso real
    const withoutSecret = { PATH: process.env.PATH };
    expect(() =>
      execFileSync("node", [script, "a@b.c"], { encoding: "utf8", env: withoutSecret }),
    ).toThrow();
  });
});
