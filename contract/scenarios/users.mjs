// Group: users — admin-only listing, profiles, creation, updates (password change revokes other
// sessions), role changes, blocking, session revocation and soft/permanent deletion.
// Throwaway users are created through the admin endpoint (it is not rate limited); demo
// accounts are never mutated beyond reversible reads.
export default {
  name: "users",
  modes: ["basic", "full"],
  async run(ctx) {
    const createUser = async ({ name, email, password = "Password123!", role } = {}) => {
      const res = await ctx.post(
        "/api/users",
        {
          name: name || "Contract User",
          email: email || `contract-user-${Math.random().toString(36).slice(2, 10)}@example.com`,
          password,
          ...(role ? { role } : {}),
        },
        { token: ctx.tokens.admin },
      );
      if (res.status !== 201)
        throw new Error(`createUser failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      return ctx.data(res);
    };

    await ctx.t("users API needs a token, and admin rights for the list", async () => {
      await ctx.loginAs("admin");
      await ctx.loginAs("user");
      const anon = await ctx.get("/api/users", { token: null });
      ctx.status(anon, 401);
      ctx.contentType(anon, "application/json");
      ctx.error(anon, { meta: "required" });
      const garbage = await ctx.get("/api/users", { token: "garbage-token" });
      ctx.status(garbage, 401, "garbage bearer");
      const nonAdmin = await ctx.get("/api/users", { token: ctx.tokens.user });
      ctx.status(nonAdmin, 403, "regular user list");
      ctx.error(nonAdmin);
      const anonCreate = await ctx.post(
        "/api/users",
        { name: "X", email: "x@example.com", password: "Password123!" },
        { token: null },
      );
      ctx.status(anonCreate, 401, "create without token");
      const nonAdminCreate = await ctx.post(
        "/api/users",
        { name: "X", email: "x@example.com", password: "Password123!" },
        { token: ctx.tokens.user },
      );
      ctx.status(nonAdminCreate, 403, "create as regular user");
    });

    await ctx.t("profiles: self or admin read; foreign profile → 403; missing → 404", async () => {
      const self = await ctx.get("/api/users/{{userId}}", { token: ctx.tokens.user });
      ctx.status(self, 200, "read own profile");
      ctx.envelope(self);
      const foreign = await ctx.get("/api/users/{{adminId}}", { token: ctx.tokens.user });
      ctx.status(foreign, 403, "foreign profile as regular user");
      ctx.eq(
        foreign.body.message,
        "Forbidden: You do not have permission to view this user profile.",
        "403 message",
      );
      const byAdmin = await ctx.get("/api/users/{{userId}}", { token: ctx.tokens.admin });
      ctx.status(byAdmin, 200, "admin reads any profile");
      const missing = await ctx.get("/api/users/11111111-2222-3333-4444-555555555555", {
        token: ctx.tokens.admin,
      });
      ctx.status(missing, 404, "missing user");
      ctx.eq(
        missing.body.message,
        "User with ID '11111111-2222-3333-4444-555555555555' not found.",
        "404 message",
      );
    });

    await ctx.t("admin list: envelope, pagination and secrets never exposed", async () => {
      const res = await ctx.get("/api/users?limit=2", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.pagination(res, { page: 1, limit: 2 });
      ctx.ok(res.body.data.length <= 2, "limit honoured");
      for (const u of res.body.data) {
        ctx.hasFields(
          u,
          [
            "id",
            "name",
            "email",
            "role",
            "isBlocked",
            "blockedReason",
            "deletedAt",
            "createdAt",
            "emailVerifiedAt",
            "totpEnabledAt",
          ],
          "user",
        );
        ctx.lacksFields(u, ["password", "totpSecret", "totpLastStep"], "user");
        ctx.ok(typeof u.isBlocked === "boolean", "isBlocked boolean");
      }
      const single = await ctx.get("/api/users/{{userId}}?include=tasks,sessions", {
        token: ctx.tokens.admin,
      });
      ctx.status(single, 200, "include whitelist");
      ctx.ok(Array.isArray(ctx.data(single).tasks), "tasks relation expanded");
      ctx.ok(Array.isArray(ctx.data(single).sessions), "sessions relation expanded");
      const bogus = await ctx.get("/api/users/{{userId}}?include=bogus", {
        token: ctx.tokens.admin,
      });
      ctx.status(bogus, 200, "unknown include is ignored");
      ctx.ok(
        ctx.data(bogus).tasks === undefined && ctx.data(bogus).sessions === undefined,
        "no relations expanded",
      );
    });

    await ctx.t("list filters, search, sorting and the limit cap", async () => {
      const byRole = await ctx.get("/api/users?role=admin&limit=100", { token: ctx.tokens.admin });
      ctx.status(byRole, 200);
      ctx.ok(byRole.body.data.length > 0, "role filter matches");
      ctx.ok(
        byRole.body.data.every((u) => u.role === "admin"),
        "every row admin",
      );
      const filtered = await ctx.get("/api/users?filter[role]=user&limit=100", {
        token: ctx.tokens.admin,
      });
      ctx.status(filtered, 200);
      ctx.ok(
        filtered.body.data.every((u) => u.role === "user"),
        "filter[role]=user",
      );
      const blocked = await ctx.get("/api/users?filter[isBlocked]=false&limit=100", {
        token: ctx.tokens.admin,
      });
      ctx.status(blocked, 200);
      ctx.ok(
        blocked.body.data.every((u) => u.isBlocked === false),
        "filter[isBlocked]=false",
      );
      const search = await ctx.get("/api/users?search=ana&limit=10", { token: ctx.tokens.admin });
      ctx.status(search, 200);
      ctx.ok(
        search.body.data.some((u) => u.email.includes("ana@example.com")),
        "search finds ana",
      );
      const unknownFilter = await ctx.get("/api/users?filter[nonsense]=1&limit=5", {
        token: ctx.tokens.admin,
      });
      ctx.status(unknownFilter, 200, "unknown filter field ignored");
      const badOp = await ctx.get("/api/users?filter[role][gte]=ad", {
        token: ctx.tokens.admin,
      });
      ctx.status(badOp, 400, "operator not allowed for the field type");
      ctx.error(badOp);
      const badValue = await ctx.get("/api/users?filter[isBlocked]=yes", {
        token: ctx.tokens.admin,
      });
      ctx.status(badValue, 400, "invalid boolean value");
      const over = await ctx.get("/api/users?limit=101", { token: ctx.tokens.admin });
      ctx.status(over, 400, "limit>100");
      ctx.fieldErrors(over, "limit");
      const badSort = await ctx.get("/api/users?sortBy=bogus", { token: ctx.tokens.admin });
      ctx.status(badSort, 400, "invalid sortBy");
      const sorted = await ctx.get("/api/users?sort=-createdAt,name&limit=20", {
        token: ctx.tokens.admin,
      });
      ctx.status(sorted, 200, "multi-field sort");
    });

    await ctx.t(
      "admin creates users with any role; duplicates and bad payloads rejected",
      async () => {
        const invalid = await ctx.post(
          "/api/users",
          { name: "X", email: "not-an-email", password: "short" },
          { token: ctx.tokens.admin },
        );
        ctx.status(invalid, 400);
        ctx.error(invalid, { meta: "required" });
        ctx.fieldErrors(invalid, "email");
        ctx.fieldErrors(invalid, "password");
        const emoji = await ctx.post(
          "/api/users",
          { name: "Emoji", email: "emoji-user@example.com", password: "😀".repeat(40) },
          { token: ctx.tokens.admin },
        );
        ctx.status(emoji, 400, "password over 72 bytes");
        const created = await createUser({ name: "Contract Target", role: "user" });
        ctx.hasFields(created, ["id", "name", "email", "role"], "created user");
        ctx.eq(created.role, "user", "role honoured");
        ctx.lacksFields(created, ["password"], "created user");
        ctx.vars.createdUserId = created.id;
        ctx.vars.createdEmail = created.email;
        const dup = await ctx.post(
          "/api/users",
          { name: "Contract Target", email: created.email, password: "Password123!" },
          { token: ctx.tokens.admin },
        );
        ctx.status(dup, 409, "duplicate email");
        ctx.error(dup);
      },
    );

    await ctx.t(
      "changing own password needs currentPassword and revokes other sessions",
      async () => {
        const first = await ctx.post(
          "/api/auth/login",
          { email: ctx.vars.createdEmail, password: "Password123!" },
          { token: null },
        );
        ctx.status(first, 200, "first login of the created user");
        const t1 = first.body.accessToken;
        const second = await ctx.post(
          "/api/auth/login",
          { email: ctx.vars.createdEmail, password: "Password123!" },
          { token: null },
        );
        ctx.status(second, 200, "second device login");
        const t2 = second.body.accessToken;

        const noCurrent = await ctx.put(
          "/api/users/{{createdUserId}}",
          { password: "ChangedPass123!" },
          { token: t1 },
        );
        ctx.status(noCurrent, 403, "password change without currentPassword");
        const wrongCurrent = await ctx.put(
          "/api/users/{{createdUserId}}",
          { password: "ChangedPass123!", currentPassword: "nope-nope-1" },
          { token: t1 },
        );
        ctx.status(wrongCurrent, 403, "wrong currentPassword");

        const ok = await ctx.put(
          "/api/users/{{createdUserId}}",
          { password: "ChangedPass123!", currentPassword: "Password123!" },
          { token: t1 },
        );
        ctx.status(ok, 200, "password change with currentPassword");
        ctx.envelope(ok);
        ctx.lacksFields(ctx.data(ok), ["password"], "updated user");
        const currentAlive = await ctx.get("/api/sessions/me", { token: t1 });
        ctx.status(currentAlive, 200, "current session survives");
        const otherDead = await ctx.get("/api/sessions/me", { token: t2 });
        ctx.status(otherDead, 401, "other session revoked");

        // an admin can reset someone else's password without knowing the current one
        const adminReset = await ctx.put(
          "/api/users/{{createdUserId}}",
          { password: "AdminReset123!" },
          { token: ctx.tokens.admin },
        );
        ctx.status(adminReset, 200, "admin password reset");
        const deadAfterReset = await ctx.get("/api/sessions/me", { token: t1 });
        ctx.status(deadAfterReset, 401, "admin reset revokes every session");
        const fresh = await ctx.post(
          "/api/auth/login",
          { email: ctx.vars.createdEmail, password: "AdminReset123!" },
          { token: null },
        );
        ctx.status(fresh, 200, "login with the admin-reset password");
        ctx.vars.createdToken = fresh.body.accessToken;
        ctx.vars.createdPassword = "AdminReset123!";
      },
    );

    await ctx.t("own email change requires currentPassword; taken email → 409", async () => {
      const t = ctx.vars.createdToken;
      const noCurrent = await ctx.put(
        "/api/users/{{createdUserId}}",
        { email: "moved-contract@example.com" },
        { token: t },
      );
      ctx.status(noCurrent, 403, "email change without currentPassword");
      const wrongCurrent = await ctx.put(
        "/api/users/{{createdUserId}}",
        { email: "moved-contract@example.com", currentPassword: "nope-nope-1" },
        { token: t },
      );
      ctx.status(wrongCurrent, 403, "wrong currentPassword");
      const taken = await ctx.put(
        "/api/users/{{createdUserId}}",
        { email: "admin@example.com", currentPassword: ctx.vars.createdPassword },
        { token: t },
      );
      ctx.status(taken, 409, "email already in use");
      ctx.error(taken);
      const renamed = await ctx.put(
        "/api/users/{{createdUserId}}",
        { name: "Contract Renamed" },
        { token: t },
      );
      ctx.status(renamed, 200, "name-only change needs no password");
      ctx.eq(ctx.data(renamed).name, "Contract Renamed", "name updated");
    });

    await ctx.t("role changes take effect immediately (role read from the database)", async () => {
      const t = ctx.vars.createdToken;
      // "contains" is a supported operator for string fields; "gte" is not.
      const contains = await ctx.get("/api/users?filter[role][contains]=ad", {
        token: ctx.tokens.admin,
      });
      ctx.status(contains, 200, "contains is a valid operator");
      ctx.ok(
        contains.body.data.every((u) => u.role.includes("ad")),
        "contains filters by substring",
      );
      // Nobody edits their own role: the target must be the caller.
      const selfRole = await ctx.patch(
        "/api/users/{{adminId}}/role",
        { role: "user" },
        { token: ctx.tokens.admin },
      );
      ctx.status(selfRole, 400, "cannot change own role");
      ctx.eq(
        selfRole.body.message,
        "Invalid action: Administrators cannot change their own role.",
        "self role-change message",
      );
      const invalid = await ctx.patch(
        "/api/users/{{createdUserId}}/role",
        { role: "superuser" },
        { token: ctx.tokens.admin },
      );
      ctx.status(invalid, 400, "invalid role value");
      const missing = await ctx.patch(
        "/api/users/11111111-2222-3333-4444-555555555555/role",
        { role: "admin" },
        { token: ctx.tokens.admin },
      );
      ctx.status(missing, 404, "missing user");
      const nonAdmin = await ctx.patch(
        "/api/users/{{createdUserId}}/role",
        { role: "admin" },
        { token: t },
      );
      ctx.status(nonAdmin, 403, "role change as regular user");

      const promote = await ctx.patch(
        "/api/users/{{createdUserId}}/role",
        { role: "admin" },
        { token: ctx.tokens.admin },
      );
      ctx.status(promote, 200, "promote");
      ctx.eq(ctx.data(promote).role, "admin", "role updated");
      const canNow = await ctx.get("/api/users?limit=1", { token: t });
      ctx.status(canNow, 200, "promoted token gains admin rights immediately");
      const demote = await ctx.patch(
        "/api/users/{{createdUserId}}/role",
        { role: "user" },
        { token: ctx.tokens.admin },
      );
      ctx.status(demote, 200, "demote");
      const deniedAgain = await ctx.get("/api/users?limit=1", { token: t });
      ctx.status(deniedAgain, 403, "demoted token loses admin rights immediately");
    });

    await ctx.t("blocking suspends instantly; self-block forbidden; unknown → 404", async () => {
      const t = ctx.vars.createdToken;
      const self = await ctx.patch(
        "/api/users/{{adminId}}/block",
        { isBlocked: true },
        { token: ctx.tokens.admin },
      );
      ctx.status(self, 400, "admin cannot suspend themselves");
      const missing = await ctx.patch(
        "/api/users/11111111-2222-3333-4444-555555555555/block",
        { isBlocked: true },
        { token: ctx.tokens.admin },
      );
      ctx.status(missing, 404, "missing user");
      const invalid = await ctx.patch(
        "/api/users/{{createdUserId}}/block",
        { isBlocked: "yes" },
        { token: ctx.tokens.admin },
      );
      ctx.status(invalid, 400, "isBlocked must be a boolean");

      const block = await ctx.patch(
        "/api/users/{{createdUserId}}/block",
        { isBlocked: true, reason: "Contract test" },
        { token: ctx.tokens.admin },
      );
      ctx.status(block, 200, "block");
      ctx.envelope(block);
      ctx.eq(ctx.data(block).isBlocked, true, "isBlocked true");
      ctx.eq(ctx.data(block).blockedReason, "Contract test", "blockedReason stored");
      const dead = await ctx.get("/api/sessions/me", { token: t });
      ctx.status(dead, 403, "blocked account token rejected");
      ctx.error(dead);
      const loginBlocked = await ctx.post(
        "/api/auth/login",
        { email: ctx.vars.createdEmail, password: ctx.vars.createdPassword },
        { token: null },
      );
      ctx.status(loginBlocked, 403, "blocked account cannot sign in");

      const unblock = await ctx.patch(
        "/api/users/{{createdUserId}}/block",
        { isBlocked: false },
        { token: ctx.tokens.admin },
      );
      ctx.status(unblock, 200, "unblock");
      ctx.eq(ctx.data(unblock).isBlocked, false, "isBlocked false");
      ctx.eq(ctx.data(unblock).blockedReason, null, "blockedReason cleared");
    });

    await ctx.t("revoke-sessions: owner or admin; strangers → 403", async () => {
      // refresh the throwaway token (the block above revoked every session)
      const login = await ctx.post(
        "/api/auth/login",
        { email: ctx.vars.createdEmail, password: ctx.vars.createdPassword },
        { token: null },
      );
      ctx.status(login, 200, "login after unblock");
      const t = login.body.accessToken;
      const stranger = await ctx.post(
        "/api/users/{{createdUserId}}/revoke-sessions",
        {},
        { token: ctx.tokens.user },
      );
      ctx.status(stranger, 403, "revoke another user as regular user");
      const res = await ctx.post(
        "/api/users/{{createdUserId}}/revoke-sessions",
        {},
        { token: ctx.tokens.admin },
      );
      ctx.status(res, 200, "admin revokes sessions");
      ctx.eq(res.body.data, null, "data null");
      ctx.ok(
        /^Revoked \d+ active session\(s\) for user\.$/.test(res.body.message),
        `message: ${res.body.message}`,
      );
      const dead = await ctx.get("/api/sessions/me", { token: t });
      ctx.status(dead, 401, "target token revoked");
    });

    await ctx.t("soft delete hides the account and cannot be reactivated", async () => {
      const del = await ctx.del("/api/users/{{createdUserId}}", { token: ctx.tokens.admin });
      ctx.status(del, 200, "soft delete");
      ctx.envelope(del);
      ctx.ok(ctx.data(del).deletedAt, "deletedAt set");
      ctx.eq(ctx.data(del).isBlocked, true, "soft delete blocks the account");
      const hidden = await ctx.get("/api/users/{{createdUserId}}", { token: ctx.tokens.admin });
      ctx.status(hidden, 404, "profile hidden");
      const list = await ctx.get("/api/users?limit=100", { token: ctx.tokens.admin });
      ctx.ok(
        !ctx.data(list).some((u) => u.id === ctx.vars.createdUserId),
        "hidden from default list",
      );
      const withDeleted = await ctx.get("/api/users?includeDeleted=true&limit=100", {
        token: ctx.tokens.admin,
      });
      ctx.ok(
        ctx.data(withDeleted).some((u) => u.id === ctx.vars.createdUserId),
        "visible with includeDeleted=true",
      );
      const unblock = await ctx.patch(
        "/api/users/{{createdUserId}}/block",
        { isBlocked: false },
        { token: ctx.tokens.admin },
      );
      ctx.status(unblock, 409, "deleted accounts cannot be reactivated");
      const login = await ctx.post(
        "/api/auth/login",
        { email: ctx.vars.createdEmail, password: ctx.vars.createdPassword },
        { token: null },
      );
      ctx.status(login, 401, "deleted account cannot sign in");
    });

    await ctx.t("permanent deletion removes the account for good", async () => {
      const created = await createUser({ name: "Contract Ephemeral" });
      const del = await ctx.del(`/api/users/${created.id}?permanent=true`, {
        token: ctx.tokens.admin,
      });
      ctx.status(del, 200, "permanent delete");
      ctx.envelope(del);
      ctx.eq(ctx.data(del).id, created.id, "deleted id echoed");
      const gone = await ctx.get(`/api/users/${created.id}?includeDeleted=true`, {
        token: ctx.tokens.admin,
      });
      ctx.status(gone, 404, "gone even with includeDeleted");
      const again = await ctx.del(`/api/users/${created.id}?permanent=true`, {
        token: ctx.tokens.admin,
      });
      ctx.status(again, 404, "second permanent delete");
    });

    await ctx.t("user management actions are audited", async () => {
      // Admin actions are recorded under the *acting* admin, with the target in `entityId`
      // (only self-service actions land under `userId`), so scan the recent log by entityId.
      const res = await ctx.get("/api/audit-logs?limit=100", { token: ctx.tokens.admin });
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.pagination(res, { page: 1, limit: 100 });
      const mine = ctx.data(res).filter((a) => a.entityId === ctx.vars.createdUserId);
      const actions = new Set(mine.map((a) => a.action));
      for (const expected of [
        "BLOCK",
        "UNBLOCK",
        "ROLE_CHANGE",
        "PASSWORD_CHANGE",
        "SOFT_DELETE",
        "REVOKE_ALL_SESSIONS",
      ]) {
        ctx.ok(
          actions.has(expected),
          `audit must contain ${expected} (got: ${[...actions].join(",")})`,
        );
      }
      const block = mine.find((a) => a.action === "BLOCK");
      ctx.hasFields(
        block,
        ["id", "action", "entity", "entityId", "createdAt", "user"],
        "audit entry",
      );
      ctx.eq(block.entity, "User", "audit entity");
      ctx.eq(block.entityId, ctx.vars.createdUserId, "audit entityId");
      // the actor is the admin who performed it, with their identity inlined
      ctx.eq(block.user && block.user.id, ctx.vars.adminId, "audit actor");
      ctx.eq(block.user && block.user.role, "admin", "audit actor role");
    });
  },
};
