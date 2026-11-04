import { Logger } from "@nestjs/common";
import { parseEnv } from "../src/config/env";
import { pseudonym } from "../src/common/utils/pii";
import { SeedService } from "../src/database/seed.service";
import type { PrismaService } from "../src/database/prisma.service";

/**
 * PII policy (audit finding): the production admin bootstrap must not write the raw
 * ADMIN_EMAIL into the log stream — the same pseudonymization rule the rate-limit and
 * audit surfaces follow (src/common/utils/pii.ts).
 */
describe("SeedService production bootstrap logs no raw address", () => {
  const ADMIN_EMAIL = "Chief@Example.com";

  const buildSeed = () => {
    const env = parseEnv({
      NODE_ENV: "production",
      AUTH_MODE: "basic",
      JWT_SECRET: "a".repeat(48),
      JWT_REFRESH_SECRET: "b".repeat(48),
      ADMIN_EMAIL,
      ADMIN_PASSWORD: "super-secret-password",
    });
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      user: {
        count: jest.fn(async () => 0),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        }),
      },
    } as unknown as PrismaService;
    const seed = new SeedService(prisma, env, { auth: true, accountSecurity: false });
    return { seed, env, created };
  };

  it("creates the administrator and logs only its pseudonym", async () => {
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { seed, env, created } = buildSeed();
      await seed.run();

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ email: ADMIN_EMAIL.toLowerCase(), role: "admin" });

      const logged = logSpy.mock.calls.flat().join(" ");
      expect(logged).not.toContain("chief@example.com");
      expect(logged).not.toContain("Chief@Example.com");
      expect(logged).toContain(pseudonym(env.JWT_SECRET, ADMIN_EMAIL));
    } finally {
      logSpy.mockRestore();
    }
  });
});
