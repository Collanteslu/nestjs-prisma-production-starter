import os from "node:os";

/**
 * The suite migrates a database, registers users and sends mail. test/setup-env.ts must
 * therefore force a throw-away database and a harmless mail transport whatever the
 * developer's shell exports (run with DATABASE_URL / TURSO_DATABASE_URL / SMTP_URL set to
 * see this stay green).
 */
describe("test environment isolation", () => {
  it("always uses a temporary SQLite database", () => {
    expect(process.env.DATABASE_URL).toContain(os.tmpdir());
    expect(process.env.DATABASE_URL?.startsWith("file:")).toBe(true);
  });

  it("never points at a remote database or a real mail server", () => {
    expect(process.env.TURSO_DATABASE_URL).toBeFalsy();
    expect(process.env.TURSO_AUTH_TOKEN).toBeFalsy();
    expect(process.env.SMTP_URL).toBeFalsy();
    expect(process.env.MAIL_TRANSPORT).toBe("log");
  });
});
