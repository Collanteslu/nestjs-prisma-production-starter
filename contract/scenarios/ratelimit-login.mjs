// Group: ratelimit-login — per-account lockout (5 failed logins → 429 for that account only)
// and the per-IP login limiter (10/min) that kicks in afterwards. Runs last on purpose: it
// exhausts the login limiter and needs no successful login afterwards.
export default {
  name: "ratelimit-login",
  modes: ["basic", "full"],
  async run(ctx) {
    let tmp = null;

    await ctx.t("5 failed logins lock the account; the 6th → 429 with Retry-After", async () => {
      tmp = await ctx.registerTmp("lockout");
      let locked = null;
      for (let i = 0; i < 5; i++) {
        const res = await ctx.post(
          "/api/auth/login",
          { email: tmp.email, password: "wrong-password-1" },
          { token: null },
        );
        ctx.status(res, 401, `failed attempt ${i + 1}`);
        ctx.error(res);
      }
      // the account is locked now: even the CORRECT password is refused
      locked = await ctx.post(
        "/api/auth/login",
        { email: tmp.email, password: tmp.password },
        { token: null },
      );
      ctx.status(locked, 429, "locked account");
      ctx.contentType(locked, "application/json");
      ctx.error(locked);
      ctx.eq(
        locked.body.message,
        "Too many failed login attempts for this account. Please try again later.",
        "lockout message",
      );
      const retryAfter = Number(locked.headers["retry-after"]);
      ctx.ok(
        Number.isFinite(retryAfter) && retryAfter >= 1,
        `Retry-After: ${locked.headers["retry-after"]}`,
      );
      ctx.ok(!!locked.headers["x-ratelimit-limit"], "X-RateLimit-Limit header still present");
      // the credentials themselves are fine: the lockout, not the password, refused them
      ctx.ok(locked.body.data === undefined, "no tokens leaked while locked");
    });

    await ctx.t("the lockout is scoped to the account, not the IP", async () => {
      const admin = await ctx.post(
        "/api/auth/login",
        { email: "admin@example.com", password: "password123" },
        { token: null },
      );
      ctx.status(admin, 200, "admin can still sign in");
      ctx.ok(typeof admin.body.accessToken === "string", "admin gets tokens");
      // ...while the throwaway stays locked
      const stillLocked = await ctx.post(
        "/api/auth/login",
        { email: tmp.email, password: tmp.password },
        { token: null },
      );
      ctx.status(stillLocked, 429, "throwaway still locked");
      ctx.eq(
        stillLocked.body.message,
        "Too many failed login attempts for this account. Please try again later.",
        "same lockout message",
      );
    });

    await ctx.t("per-IP login limiter (10/min) ends the flood with a 429", async () => {
      let limited = null;
      let successes = 0;
      // the group has already made 8 login requests; keep going until the IP limiter trips
      for (let i = 0; i < 6 && !limited; i++) {
        const res = await ctx.post(
          "/api/auth/login",
          { email: "admin@example.com", password: "password123" },
          { token: null },
        );
        if (res.status === 429) {
          limited = res;
          break;
        }
        ctx.status(res, 200, `login ${i + 1} before the IP limit`);
        successes++;
      }
      ctx.ok(limited, "a 429 must be observed");
      if (!limited) return;
      ctx.ok(successes < 6, "some requests passed before the limit");
      ctx.eq(
        limited.body.message,
        "Too many requests. Please slow down and try again later.",
        "IP limiter message (not the lockout one)",
      );
      ctx.eq(limited.headers["x-ratelimit-limit"], "10", "X-RateLimit-Limit");
      ctx.eq(limited.headers["x-ratelimit-remaining"], "0", "X-RateLimit-Remaining");
      const retryAfter = Number(limited.headers["retry-after"]);
      ctx.ok(
        Number.isFinite(retryAfter) && retryAfter >= 1,
        `Retry-After: ${limited.headers["retry-after"]}`,
      );
      ctx.ok(typeof limited.body.retryAfterSeconds === "number", "retryAfterSeconds in body");
      ctx.error(limited, { meta: "required" });
    });
  },
};
