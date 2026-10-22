// Group: mfa — TOTP enrolment (setup → enable), second-factor login (missing/replayed codes,
// recovery codes), disable, admin reset of a lost device, and the non-leakage of TOTP secrets.
// One throwaway account carries the whole flow; the password-confirm and login budgets are
// respected (at most one wrong password confirmation at a time, ≤ 9 /login requests).
import { totpCandidates } from "../net.mjs";

export default {
  name: "mfa",
  modes: ["full"],
  async run(ctx) {
    const tmp = await ctx.registerTmp("mfa");
    const login = (extra = {}) =>
      ctx.post(
        "/api/auth/login",
        { email: tmp.email, password: tmp.password, ...extra },
        { token: null },
      );
    const mfa = (path, body, opts) => ctx.post(`/api/auth/mfa/${path}`, body, opts);

    await ctx.t("mfa endpoints require a valid bearer token", async () => {
      const anonSetup = await mfa("setup", { currentPassword: tmp.password }, { token: null });
      ctx.status(anonSetup, 401, "setup without token");
      ctx.contentType(anonSetup, "application/json");
      ctx.error(anonSetup, { meta: "required" });
      const garbage = await mfa(
        "setup",
        { currentPassword: tmp.password },
        { token: "garbage-token" },
      );
      ctx.status(garbage, 401, "setup with garbage token");
      const anonEnable = await mfa("enable", { code: "123456" }, { token: null });
      ctx.status(anonEnable, 401, "enable without token");
    });

    await ctx.t("setup needs the password and returns secret + otpauth URL", async () => {
      const first = await login();
      ctx.status(first, 200, "throwaway login");
      ctx.token = first.body.accessToken;

      const wrongPw = await mfa("setup", { currentPassword: "wrong-pass-9" }, { token: ctx.token });
      ctx.status(wrongPw, 403, "wrong password");
      ctx.eq(wrongPw.body.message, "Current password is incorrect.", "wrong-password message");

      const setup = await mfa("setup", { currentPassword: tmp.password }, { token: ctx.token });
      ctx.status(setup, 200, "setup");
      ctx.envelope(setup);
      const { secret, otpauthUrl } = ctx.data(setup);
      ctx.ok(/^[A-Z2-7]+$/.test(secret), `secret looks base32: ${secret}`);
      ctx.ok(
        typeof otpauthUrl === "string" && otpauthUrl.startsWith("otpauth://totp/"),
        `otpauthUrl: ${otpauthUrl}`,
      );
      ctx.ok(otpauthUrl.includes(`secret=${secret}`), "otpauthUrl embeds the secret");
      ctx.vars.mfaSecret = secret;
    });

    await ctx.t("enable confirms the first code and hands out 10 recovery codes", async () => {
      const secret = ctx.vars.mfaSecret;
      const bad = await mfa("enable", { code: "000000" }, { token: ctx.token });
      ctx.status(bad, 400, "wrong code");
      ctx.error(bad);
      const code = totpCandidates(secret)[0];
      const enable = await mfa("enable", { code }, { token: ctx.token });
      ctx.status(enable, 200, "enable with a real code");
      ctx.envelope(enable);
      const codes = ctx.data(enable).recoveryCodes;
      ctx.ok(
        Array.isArray(codes) && codes.length === 10,
        `10 recovery codes, got ${codes && codes.length}`,
      );
      ctx.ok(
        codes.every((c) => typeof c === "string" && c.length >= 5),
        "recovery codes are non-empty strings",
      );
      ctx.ok(new Set(codes).size === 10, "recovery codes are unique");
      ctx.vars.mfaRecoveryCodes = codes;
      ctx.vars.mfaUsedCode = code;
    });

    await ctx.t("setup while already enabled → 409", async () => {
      const again = await mfa("setup", { currentPassword: tmp.password }, { token: ctx.token });
      ctx.status(again, 409);
      ctx.error(again);
      ctx.eq(again.body.message, "Two-factor authentication is already enabled.", "409 message");
    });

    await ctx.t("login demands the second factor; replays and stale codes fail", async () => {
      const missing = await login();
      ctx.status(missing, 401, "login without a code");
      ctx.ok(
        missing.body.details && missing.body.details.code === "MFA_REQUIRED",
        `details.code: ${JSON.stringify(missing.body.details)}`,
      );
      ctx.ok(missing.body.accessToken === undefined, "no tokens without the second factor");

      // the enable step consumed this exact code: replaying it must fail
      const replay = await login({ totpCode: ctx.vars.mfaUsedCode });
      ctx.status(replay, 401, "replayed code");
      ctx.ok(
        replay.body.details && replay.body.details.code === "MFA_INVALID",
        `details.code: ${JSON.stringify(replay.body.details)}`,
      );

      // the next time step (±1 step of drift is accepted) works exactly once
      const nextCode = totpCandidates(ctx.vars.mfaSecret)[2];
      const ok = await login({ totpCode: nextCode });
      ctx.status(ok, 200, "next-step code");
      ctx.ok(typeof ok.body.accessToken === "string", "tokens issued");
      const again = await login({ totpCode: nextCode });
      ctx.status(again, 401, "same code cannot be used twice");
      ctx.ok(
        again.body.details && again.body.details.code === "MFA_INVALID",
        "replay is MFA_INVALID",
      );

      // a recovery code works once too
      const rc = ctx.vars.mfaRecoveryCodes[0];
      const withRc = await login({ recoveryCode: rc });
      ctx.status(withRc, 200, "recovery code login");
      const rcAgain = await login({ recoveryCode: rc });
      ctx.status(rcAgain, 401, "recovery code is single-use");
    });

    await ctx.t(
      "disable needs password + exactly one factor, then login works without code",
      async () => {
        const both = await mfa(
          "disable",
          { currentPassword: tmp.password, code: "123456", recoveryCode: "x".repeat(10) },
          { token: ctx.token },
        );
        ctx.status(both, 400, "code and recoveryCode are mutually exclusive");
        const badPw = await mfa(
          "disable",
          { currentPassword: "wrong-pass-9", recoveryCode: ctx.vars.mfaRecoveryCodes[1] },
          { token: ctx.token },
        );
        ctx.status(badPw, 403, "wrong password");
        ctx.eq(
          badPw.body.message,
          "Current password or code is incorrect.",
          "wrong-password message",
        );
        const ok = await mfa(
          "disable",
          { currentPassword: tmp.password, recoveryCode: ctx.vars.mfaRecoveryCodes[1] },
          { token: ctx.token },
        );
        ctx.status(ok, 200, "disable with password + recovery code");
        ctx.eq(ctx.data(ok), null, "data null");

        const plain = await login();
        ctx.status(plain, 200, "login without a second factor after disable");
        ctx.token = plain.body.accessToken;
        ctx.vars.mfaPassword = tmp.password;
      },
    );

    await ctx.t("admin resets a lost device; self-service is refused", async () => {
      // re-enrol so there is something for the admin to reset
      const setup = await mfa("setup", { currentPassword: tmp.password }, { token: ctx.token });
      ctx.status(setup, 200, "re-setup");
      const enable = await mfa(
        "enable",
        { code: totpCandidates(ctx.data(setup).secret)[0] },
        { token: ctx.token },
      );
      ctx.status(enable, 200, "re-enable");
      const tmpBearer = ctx.token;

      await ctx.loginAs("admin");
      const adminBearer = ctx.tokens.admin;
      ctx.token = tmpBearer; // keep the persona of the rest of the group

      // `requireAdmin` guards the route, so a non-admin is turned away before the handler runs —
      // even when naming themself.
      const stranger = await ctx.del("/api/users/{{adminId}}/mfa", { token: tmpBearer });
      ctx.status(stranger, 403, "non-admin cannot reset anyone");
      ctx.eq(
        stranger.body.message,
        "Forbidden: This action requires administrator privileges.",
        "non-admin message",
      );

      // An admin may not strip their own second factor with a bare access token: that is exactly
      // what a stolen token would want, so it is pushed to the password+code flow.
      const self = await ctx.del("/api/users/{{adminId}}/mfa", { token: adminBearer });
      ctx.status(self, 403, "admin route refuses self-service");
      ctx.eq(
        self.body.message,
        "Use POST /api/auth/mfa/disable to turn off your own two-factor authentication.",
        "self-reset message",
      );

      const admin = await ctx.del("/api/users/{{tmpUserId}}/mfa", { token: adminBearer });
      ctx.status(admin, 200, "admin reset");
      ctx.envelope(admin);
      ctx.eq(ctx.data(admin), null, "data null");
      const dead = await ctx.get("/api/sessions/me", { token: tmpBearer });
      ctx.status(dead, 401, "admin reset revokes every session of the target");

      const plain = await login();
      ctx.status(plain, 200, "login without a second factor after the admin reset");
      ctx.token = plain.body.accessToken;
      const again = await ctx.del("/api/users/{{tmpUserId}}/mfa", { token: adminBearer });
      ctx.status(again, 409, "second reset → 409");
      ctx.eq(again.body.message, "The user has no two-factor authentication.", "409 message");
      const missing = await ctx.del("/api/users/11111111-2222-3333-4444-555555555555/mfa", {
        token: adminBearer,
      });
      ctx.status(missing, 404, "missing user");
    });

    await ctx.t("the users API never exposes TOTP internals", async () => {
      const res = await ctx.get("/api/users/{{tmpUserId}}", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.lacksFields(ctx.data(res), ["totpSecret", "totpLastStep", "password"], "user");
      ctx.hasFields(ctx.data(res), ["totpEnabledAt"], "user");
      const list = await ctx.get("/api/users?limit=100", { token: ctx.tokens.admin });
      ctx.status(list, 200);
      ctx.ok(
        ctx.data(list).every((u) => !("totpSecret" in u) && !("totpLastStep" in u)),
        "list must not leak totp internals",
      );
    });

    await ctx.t("MFA lifecycle is audited (setup, enable, disable, reset)", async () => {
      // Self-service MFA events land under the throwaway's `userId`; the admin reset is recorded
      // under the acting admin with the target in `entityId`, so scan the recent log by entityId.
      const res = await ctx.get("/api/audit-logs?limit=100", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.pagination(res, { page: 1, limit: 100 });
      const mine = ctx
        .data(res)
        .filter((a) => a.entityId === ctx.vars.tmpUserId || a.userId === ctx.vars.tmpUserId);
      const actions = new Set(mine.map((a) => a.action));
      for (const expected of ["MFA_SETUP", "MFA_ENABLED", "MFA_DISABLED", "MFA_RESET"]) {
        ctx.ok(
          actions.has(expected),
          `audit must contain ${expected} (got: ${[...actions].join(",")})`,
        );
      }
      const sample = mine.find((a) => a.action === "MFA_ENABLED");
      ctx.eq(sample.entity, "User", "MFA audit entity");
      ctx.eq(sample.userId, ctx.vars.tmpUserId, "audit points at the throwaway");
      // the admin reset is attributed to the admin who performed it, targeting the throwaway
      const reset = mine.find((a) => a.action === "MFA_RESET");
      ctx.eq(reset.entityId, ctx.vars.tmpUserId, "MFA_RESET targets the throwaway");
      ctx.eq(reset.userId, ctx.vars.adminId, "MFA_RESET is attributed to the admin");
    });
  },
};
