// Group: audit — the audit trail is admin-only, paginated, filterable, ordered newest-first
// and records the side effects the earlier groups produced.
export default {
  name: "audit",
  modes: ["basic", "full"],
  async run(ctx) {
    await ctx.t("audit logs are admin-only", async () => {
      const anon = await ctx.get("/api/audit-logs", { token: null });
      ctx.status(anon, 401);
      ctx.contentType(anon, "application/json");
      ctx.error(anon, { meta: "required" });
      const garbage = await ctx.get("/api/audit-logs", { token: "garbage-token" });
      ctx.status(garbage, 401, "garbage bearer");
      await ctx.loginAs("user");
      const nonAdmin = await ctx.get("/api/audit-logs", { token: ctx.tokens.user });
      ctx.status(nonAdmin, 403, "regular user");
      ctx.error(nonAdmin);
      await ctx.loginAs("admin");
    });

    await ctx.t("admin list: envelope, default pagination, entry shape, newest first", async () => {
      const res = await ctx.get("/api/audit-logs", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.pagination(res, { page: 1, limit: 20 }); // default limit is 20
      ctx.ok(res.body.data.length > 0, "data is non-empty");
      for (const entry of res.body.data.slice(0, 5)) {
        ctx.hasFields(
          entry,
          [
            "id",
            "action",
            "entity",
            "entityId",
            "details",
            "ipAddress",
            "userAgent",
            "createdAt",
            "user",
          ],
          "audit entry",
        );
      }
      const withUser = res.body.data.find((e) => e.user);
      ctx.ok(withUser, "at least one entry embeds its user");
      ctx.hasFields(withUser.user, ["id", "name", "email", "role"], "audit.user");
      ctx.lacksFields(withUser.user, ["password"], "audit.user");
      const stamps = res.body.data.map((e) => e.createdAt);
      const ordered = [...stamps].sort().reverse();
      ctx.eq(JSON.stringify(stamps), JSON.stringify(ordered), "entries sorted by createdAt desc");
    });

    await ctx.t("filters by action, entity and userId; invalid query params → 400", async () => {
      const byAction = await ctx.get("/api/audit-logs?action=LOGIN&limit=10", {
        token: ctx.tokens.admin,
      });
      ctx.status(byAction, 200);
      ctx.ok(byAction.body.data.length > 0, "LOGIN entries exist");
      ctx.ok(
        byAction.body.data.every((e) => e.action === "LOGIN"),
        "action filter honoured",
      );
      const byEntity = await ctx.get("/api/audit-logs?entity=Task&limit=10", {
        token: ctx.tokens.admin,
      });
      ctx.status(byEntity, 200);
      ctx.ok(byEntity.body.data.length > 0, "Task entries exist");
      ctx.ok(
        byEntity.body.data.every((e) => e.entity === "Task"),
        "entity filter honoured",
      );
      const byUser = await ctx.get("/api/audit-logs?userId={{adminId}}&limit=10", {
        token: ctx.tokens.admin,
      });
      ctx.status(byUser, 200);
      ctx.ok(byUser.body.data.length > 0, "admin entries exist");
      ctx.ok(
        byUser.body.data.every((e) => e.userId === ctx.vars.adminId),
        "userId filter honoured",
      );
      const nothing = await ctx.get("/api/audit-logs?action=NO_SUCH_ACTION&limit=10", {
        token: ctx.tokens.admin,
      });
      ctx.status(nothing, 200, "unknown action returns an empty page");
      ctx.eq(nothing.body.data.length, 0, "empty data");
      const over = await ctx.get("/api/audit-logs?limit=101", { token: ctx.tokens.admin });
      ctx.status(over, 400, "limit>100");
      ctx.fieldErrors(over, "limit");
      const badPage = await ctx.get("/api/audit-logs?page=0", { token: ctx.tokens.admin });
      ctx.status(badPage, 400, "page=0");
    });

    await ctx.t("earlier groups left their trail (persistence side effects)", async () => {
      // one cheap filtered query per expected action: robust against the growing total
      const expect = [
        ["LOGIN", "Session"],
        ["LOGIN_FAILED", "Session"],
        ["LOGOUT", "Session"],
        ["REGISTER", "User"],
        ["REVOKE_SESSION", "Session"],
        ["REVOKE_ALL_SESSIONS", "User"],
        ["CREATE", "Task"],
        ["UPDATE", "Task"],
        ["SOFT_DELETE", "Task"],
        ["RESTORE", "Task"],
        ["DELETE_PERMANENT", "Task"],
        ["BLOCK", "User"],
        ["UNBLOCK", "User"],
        ["ROLE_CHANGE", "User"],
        ["PASSWORD_CHANGE", "User"],
      ];
      for (const [action, entity] of expect) {
        const res = await ctx.get(`/api/audit-logs?action=${action}&entity=${entity}&limit=1`, {
          token: ctx.tokens.admin,
        });
        ctx.status(res, 200, `query ${action}/${entity}`);
        ctx.ok(res.body.data.length > 0, `audit must contain ${action} on ${entity}`);
        if (res.body.data[0]) ctx.eq(res.body.data[0].entity, entity, `${action} entity`);
      }
    });
  },
};
