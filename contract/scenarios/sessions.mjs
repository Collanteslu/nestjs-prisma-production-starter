// Group: sessions — session listing, per-session revocation (owner or Admin, foreign → 404),
// revoke-all, and real-time invalidation of the bearer token.
export default {
  name: "sessions",
  modes: ["basic", "full"],
  async run(ctx) {
    await ctx.t("session routes need a valid bearer token", async () => {
      const anon = await ctx.get("/api/sessions/me", { token: null });
      ctx.status(anon, 401);
      ctx.contentType(anon, "application/json");
      ctx.error(anon, { meta: "required" });
      const garbage = await ctx.get("/api/sessions/me", { token: "garbage-token" });
      ctx.status(garbage, 401, "garbage bearer");
      ctx.error(garbage);
      const anonDelete = await ctx.del("/api/sessions/some-session", { token: null });
      ctx.status(anonDelete, 401, "DELETE without token");
      const anonRevokeAll = await ctx.post("/api/sessions/revoke-all", {}, { token: null });
      ctx.status(anonRevokeAll, 401, "revoke-all without token");
    });

    await ctx.t("GET /api/sessions/me lists own sessions with isCurrent", async () => {
      await ctx.loginAs("admin");
      await ctx.loginAs("user");
      const res = await ctx.get("/api/sessions/me");
      ctx.status(res, 200);
      ctx.eq(res.body.success, true, "success");
      ctx.ok(typeof res.body.count === "number", `count: ${res.body.count}`);
      ctx.eq(res.body.count, res.body.data.length, "count matches data length");
      ctx.ok(!res.body.pagination, "sessions list has no pagination");
      ctx.isUuid(res.body.currentSessionId, "currentSessionId");
      ctx.ok(Array.isArray(res.body.data) && res.body.data.length > 0, "data is a non-empty array");
      for (const s of res.body.data) {
        ctx.hasFields(
          s,
          [
            "id",
            "userId",
            "userAgent",
            "ipAddress",
            "isActive",
            "expiresAt",
            "createdAt",
            "updatedAt",
            "isCurrent",
          ],
          "session",
        );
        ctx.eq(s.userId, ctx.vars.userId, "every session belongs to the caller");
        ctx.ok(typeof s.isActive === "boolean", "isActive is a boolean");
        ctx.ok(typeof s.isCurrent === "boolean", "isCurrent is a boolean");
      }
      const current = res.body.data.find((s) => s.isCurrent);
      ctx.ok(current, "exactly the current session is flagged isCurrent");
      ctx.eq(current.id, res.body.currentSessionId, "isCurrent session matches currentSessionId");
    });

    await ctx.t("foreign and unknown session ids answer 404 identically", async () => {
      // ana tries to revoke the admin's current session
      const foreign = await ctx.del("/api/sessions/{{adminSessionId}}", { token: ctx.tokens.user });
      ctx.status(foreign, 404, "foreign session");
      ctx.error(foreign);
      const missing = await ctx.del("/api/sessions/session-does-not-exist", {
        token: ctx.tokens.user,
      });
      ctx.status(missing, 404, "missing session");
      ctx.error(missing);
      const pattern = /^Session with ID '.*' not found\.$/;
      ctx.ok(pattern.test(foreign.body.message), `foreign message: ${foreign.body.message}`);
      ctx.ok(pattern.test(missing.body.message), `missing message: ${missing.body.message}`);
      // the failed attempts must not have revoked anything
      const adminAlive = await ctx.get("/api/sessions/me", { token: ctx.tokens.admin });
      ctx.status(adminAlive, 200, "admin session untouched");
    });

    await ctx.t("an admin can revoke another user session (instant 401)", async () => {
      const res = await ctx.del("/api/sessions/{{userSessionId}}", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.eq(res.body.success, true, "success");
      ctx.eq(res.body.data, null, "data is null");
      ctx.ok(
        typeof res.body.message === "string" && res.body.message.length > 0,
        "message present",
      );
      const dead = await ctx.get("/api/sessions/me", { token: ctx.tokens.user });
      ctx.status(dead, 401, "revoked token");
      ctx.error(dead);
      // re-authenticate the persona for the rest of the group
      await ctx.loginAs("user");
    });

    await ctx.t("revoking the own current session kills the bearer immediately", async () => {
      const res = await ctx.del("/api/sessions/{{userSessionId}}", { token: ctx.tokens.user });
      ctx.status(res, 200);
      const dead = await ctx.get("/api/sessions/me", { token: ctx.tokens.user });
      ctx.status(dead, 401, "own token after self-revocation");
      await ctx.loginAs("user");
    });

    await ctx.t("POST /api/sessions/revoke-all closes every session of the caller", async () => {
      const before = await ctx.get("/api/sessions/me", { token: ctx.tokens.user });
      ctx.status(before, 200, "list before revoke-all");
      ctx.ok(before.body.data.filter((s) => s.isActive).length >= 1, "at least one active session");
      const res = await ctx.post("/api/sessions/revoke-all", {}, { token: ctx.tokens.user });
      ctx.status(res, 200);
      ctx.eq(res.body.success, true, "success");
      ctx.eq(res.body.data, null, "data is null");
      const dead = await ctx.get("/api/sessions/me", { token: ctx.tokens.user });
      ctx.status(dead, 401, "token after revoke-all");
      // admin sessions belong to another user and must survive
      const adminAlive = await ctx.get("/api/sessions/me", { token: ctx.tokens.admin });
      ctx.status(adminAlive, 200, "admin session survives ana revoke-all");
      await ctx.loginAs("user");
    });

    await ctx.t("revocations are audited (REVOKE_SESSION, REVOKE_ALL_SESSIONS)", async () => {
      const one = await ctx.get("/api/audit-logs?action=REVOKE_SESSION&limit=20", {
        token: ctx.tokens.admin,
      });
      ctx.status(one, 200);
      ctx.envelope(one);
      ctx.ok(one.body.data.length > 0, "REVOKE_SESSION entries exist");
      ctx.eq(one.body.data[0].entity, "Session", "REVOKE_SESSION entity");
      const all = await ctx.get("/api/audit-logs?action=REVOKE_ALL_SESSIONS&limit=20", {
        token: ctx.tokens.admin,
      });
      ctx.status(all, 200);
      ctx.ok(all.body.data.length > 0, "REVOKE_ALL_SESSIONS entries exist");
      ctx.eq(all.body.data[0].entity, "User", "REVOKE_ALL_SESSIONS entity");
    });
  },
};
