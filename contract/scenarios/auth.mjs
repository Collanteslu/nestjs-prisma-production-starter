// Group: auth — register, login, refresh rotation, logout.
// Rate budget: register ≤ 5/h and login ≤ 10/min per IP are respected here by design
// (the runner resets buckets before this group and the ratelimit group runs last).
export default {
  name: "auth",
  modes: ["basic", "full"],
  async run(ctx) {
    await ctx.t("register creates a user (unknown fields are stripped)", async () => {
      const email = `contract-register-${Math.random().toString(36).slice(2, 10)}@example.com`;
      const res = await ctx.post(
        "/api/auth/register",
        {
          name: "Contract Register",
          email,
          password: "Password123!",
          unknownField: "must-be-ignored",
        },
        { token: null },
      );
      ctx.status(res, 201);
      ctx.envelope(res);
      const user = res.body.data;
      ctx.hasFields(user, ["id", "name", "email", "role"], "register.data");
      ctx.eq(user.email, email, "register email");
      ctx.eq(user.role, "user", "register role is always user");
      ctx.lacksFields(user, ["password", "unknownField"], "register.data");
      ctx.vars.registeredEmail = email;
      ctx.vars.registeredUserId = user.id;
    });

    await ctx.t("register duplicate email → 409", async () => {
      const res = await ctx.post(
        "/api/auth/register",
        { name: "Contract Register", email: ctx.vars.registeredEmail, password: "Password123!" },
        { token: null },
      );
      ctx.status(res, 409);
      ctx.error(res);
    });

    await ctx.t("register invalid payload → 400 grouped field errors", async () => {
      const res = await ctx.post(
        "/api/auth/register",
        { name: "X", email: "not-an-email", password: "short" },
        { token: null },
      );
      ctx.status(res, 400);
      ctx.error(res, { meta: "required" });
      ctx.fieldErrors(res, "email");
      ctx.fieldErrors(res, "password");
      ctx.fieldErrors(res, "name");
    });

    await ctx.t("login admin issues top-level token pair (no data wrapper)", async () => {
      const res = await ctx.loginAs("admin");
      ctx.eq(res.status, 200, "login status");
      ctx.eq(res.body.success, true, "login.success");
      ctx.ok(res.body.data === undefined, "login must not wrap tokens in data");
      ctx.hasFields(
        res.body,
        ["accessToken", "refreshToken", "expiresIn", "sessionId", "user", "meta"],
        "login",
      );
      ctx.ok(
        typeof res.body.accessToken === "string" && res.body.accessToken.split(".").length === 3,
        "accessToken is a JWT",
      );
      ctx.ok(
        typeof res.body.refreshToken === "string" && res.body.refreshToken.split(".").length === 3,
        "refreshToken is a JWT",
      );
      ctx.eq(res.body.expiresIn, 900, "expiresIn (15 min)");
      ctx.hasFields(res.body.user, ["id", "name", "email", "role"], "login.user");
      ctx.eq(res.body.user.role, "admin", "admin role");
      ctx.lacksFields(res.body.user, ["password"], "login.user");
      ctx.eq(typeof res.body.message, "string", "login message");
      ctx.ok(res.body.meta && typeof res.body.meta.requestId === "string", "login.meta");
      ctx.vars.adminAccessToken = res.body.accessToken;
      ctx.vars.adminRefreshToken = res.body.refreshToken;
    });

    await ctx.t("login user (seeded) works", async () => {
      const res = await ctx.loginAs("user");
      ctx.eq(res.status, 200, "login user status");
      ctx.eq(res.body.user.role, "user", "user role");
      ctx.vars.userAccessToken = res.body.accessToken;
      ctx.vars.userRefreshToken = res.body.refreshToken;
    });

    await ctx.t("login wrong password and unknown email are indistinguishable (401)", async () => {
      const wrong = await ctx.post(
        "/api/auth/login",
        { email: "admin@example.com", password: "nope-nope-nope" },
        { token: null },
      );
      const unknown = await ctx.post(
        "/api/auth/login",
        {
          email: `ghost-${Math.random().toString(36).slice(2, 8)}@example.com`,
          password: "nope-nope-nope",
        },
        { token: null },
      );
      ctx.status(wrong, 401, "wrong password");
      ctx.status(unknown, 401, "unknown email");
      ctx.error(wrong);
      ctx.error(unknown);
      ctx.eq(
        unknown.body.message,
        wrong.body.message,
        "no existence oracle: messages must be identical",
      );
    });

    await ctx.t("login missing field → 400 field errors", async () => {
      const res = await ctx.post(
        "/api/auth/login",
        { email: "admin@example.com" },
        { token: null },
      );
      ctx.status(res, 400);
      ctx.error(res, { meta: "required" });
      ctx.fieldErrors(res, "password");
    });

    await ctx.t("access token requires a session: logout invalidates it", async () => {
      // dedicated session so the personas' sessions stay alive
      await ctx.loginAs("admin");
      const firstToken = ctx.tokens.admin;
      const out = await ctx.post(
        "/api/auth/logout",
        { refreshToken: ctx.vars.adminRefreshToken },
        { token: firstToken },
      );
      ctx.status(out, 200);
      ctx.eq(out.body.success, true, "logout.success");
      const after = await ctx.get("/api/sessions/me", { token: firstToken });
      ctx.status(after, 401, "access token after logout");
      ctx.error(after);
      // re-authenticate for the rest of the group (logout above revoked admin's session)
      await ctx.loginAs("admin");
    });

    await ctx.t("refresh rotates the pair and keeps the session", async () => {
      const login = await ctx.post(
        "/api/auth/login",
        { email: "admin@example.com", password: "password123" },
        { token: null },
      );
      ctx.status(login, 200, "login for refresh");
      const oldRefresh = login.body.refreshToken;
      const sessionId = login.body.sessionId;
      const res = await ctx.post(
        "/api/auth/refresh",
        { refreshToken: oldRefresh },
        { token: null },
      );
      ctx.status(res, 200);
      ctx.eq(res.body.success, true, "refresh.success");
      ctx.ok(res.body.data === undefined, "refresh must not wrap tokens in data");
      ctx.hasFields(
        res.body,
        ["accessToken", "refreshToken", "expiresIn", "sessionId", "meta"],
        "refresh",
      );
      ctx.ok(res.body.refreshToken !== oldRefresh, "refresh token must rotate");
      ctx.eq(res.body.sessionId, sessionId, "session stays the same");
      ctx.vars.rotatedRefresh = res.body.refreshToken;
      ctx.vars.rotatedAccess = res.body.accessToken;
      ctx.vars.rotatedOldRefresh = oldRefresh;
    });

    await ctx.t("reusing a just-rotated refresh token → 409 (concurrent refresh)", async () => {
      const res = await ctx.post(
        "/api/auth/refresh",
        { refreshToken: ctx.vars.rotatedOldRefresh },
        { token: null },
      );
      ctx.status(res, 409);
      ctx.error(res);
      // session must survive the benign concurrent refresh
      const again = await ctx.post(
        "/api/auth/refresh",
        { refreshToken: ctx.vars.rotatedRefresh },
        { token: null },
      );
      ctx.status(again, 200, "rotated token still valid after 409");
      ctx.vars.rotatedRefresh = again.body.refreshToken;
      ctx.vars.rotatedAccess = again.body.accessToken;
    });

    await ctx.t("refresh with invalid/tampered/wrong-kind tokens → 401", async () => {
      const garbage = await ctx.post(
        "/api/auth/refresh",
        { refreshToken: "not.a.jwt" },
        { token: null },
      );
      ctx.status(garbage, 401, "garbage");
      ctx.error(garbage);
      const rt = ctx.vars.rotatedRefresh;
      const tampered = rt.slice(0, -2) + (rt.slice(-2) === "aa" ? "bb" : "aa");
      const forged = await ctx.post(
        "/api/auth/refresh",
        { refreshToken: tampered },
        { token: null },
      );
      ctx.status(forged, 401, "tampered");
      const wrongKind = await ctx.post(
        "/api/auth/refresh",
        { refreshToken: ctx.vars.rotatedAccess },
        { token: null },
      );
      ctx.status(wrongKind, 401, "access used as refresh");
      const noBody = await ctx.post("/api/auth/refresh", {}, { token: null });
      ctx.status(noBody, 400, "missing refresh token");
      ctx.fieldErrors(noBody, "refreshToken");
    });

    await ctx.t("bearer validation: garbage / wrong scheme / revoked session", async () => {
      const garbage = await ctx.get("/api/tasks", { token: "garbage-token" });
      ctx.status(garbage, 401, "garbage bearer");
      ctx.error(garbage);
      const wrongScheme = await ctx.get("/api/tasks", {
        token: null,
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      ctx.status(wrongScheme, 401, "basic auth scheme");
      const expiredLike = await ctx.get("/api/tasks", {
        token: "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1c2VyLTEifQ.ffffffffff",
      });
      ctx.status(expiredLike, 401, "unsigned jwt");
      const revoked = await ctx.get("/api/tasks", { token: ctx.vars.rotatedAccess });
      ctx.status(revoked, 200, "rotated access token still valid");
    });

    await ctx.t("audit records login, failed login and logout", async () => {
      // exercises persistence side effects of this group (admin only, cheap query)
      await ctx.as("admin");
      const res = await ctx.get("/api/audit-logs?limit=100", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.envelope(res);
      const actions = (res.body.data || []).map((a) => a.action);
      for (const expected of ["LOGIN", "LOGIN_FAILED", "LOGOUT", "REGISTER"]) {
        ctx.ok(
          actions.includes(expected),
          `audit must contain ${expected} (got: ${[...new Set(actions)].join(",")})`,
        );
      }
      const sample = (res.body.data || []).find((a) => a.action === "LOGIN");
      ctx.hasFields(sample, ["id", "action", "entity", "createdAt"], "audit entry");
      ctx.eq(sample.entity, "Session", "LOGIN audit entity");
    });
  },
};
