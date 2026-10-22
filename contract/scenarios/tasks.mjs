// Group: tasks — CRUD, strict ownership (foreign → 404), soft delete/restore, filters,
// sorting, include whitelist and the admin-only userId/scope list modes.
//
// Mode-conditional: with AUTH_MODE=none every task route is public, tasks have no owner,
// `?userId=` / `?scope=all` answer 400 and `?include=user` is ignored. Tasks that belong to a
// user are never exposed by the public API.
export default {
  name: "tasks",
  modes: ["none", "basic", "full"],
  async run(ctx) {
    const authed = ctx.mode !== "none";

    await ctx.t("list: bearer required (basic/full) or public (none)", async () => {
      if (authed) {
        const anon = await ctx.get("/api/tasks", { token: null });
        ctx.status(anon, 401);
        ctx.contentType(anon, "application/json");
        ctx.error(anon, { meta: "required" });
        const garbage = await ctx.get("/api/tasks", { token: "garbage-token" });
        ctx.status(garbage, 401, "garbage bearer");
      } else {
        const anon = await ctx.get("/api/tasks", { token: null });
        ctx.status(anon, 200);
        ctx.envelope(anon);
        ctx.pagination(anon, { page: 1, limit: 10 });
      }
    });

    await ctx.t("list: envelope, pagination defaults and limit cap", async () => {
      if (authed) {
        await ctx.loginAs("admin");
        await ctx.loginAs("user"); // ctx.token ends as the standard user
      }
      const res = await ctx.get("/api/tasks");
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.pagination(res, { page: 1, limit: 10 });
      ctx.ok(Array.isArray(res.body.data), "data is an array");
      const over = await ctx.get("/api/tasks?limit=101");
      ctx.status(over, 400, "limit>100");
      ctx.error(over, { meta: "required" });
      ctx.fieldErrors(over, "limit");
      const badPage = await ctx.get("/api/tasks?page=0");
      ctx.status(badPage, 400, "page=0");
      const badIncludeDeleted = await ctx.get("/api/tasks?includeDeleted=banana");
      ctx.status(badIncludeDeleted, 400, "includeDeleted enum");
    });

    await ctx.t("create: ownership, defaults, unknown fields stripped", async () => {
      const res = await ctx.post("/api/tasks", {
        title: "Contract created task",
        unknownField: "must-be-ignored",
      });
      ctx.status(res, 201);
      ctx.contentType(res, "application/json");
      ctx.envelope(res);
      const task = ctx.data(res);
      ctx.hasFields(
        task,
        ["id", "title", "description", "completed", "userId", "createdAt", "deletedAt"],
        "task",
      );
      // The task model is not a `updatedAt`-stamped one: only `createdAt` and `deletedAt` are exposed.
      ctx.lacksFields(task, ["updatedAt"], "task");
      ctx.isUuid(task.id, "task.id");
      ctx.eq(task.title, "Contract created task", "title");
      ctx.eq(task.description, "", "default description");
      ctx.eq(task.completed, false, "default completed");
      ctx.eq(task.deletedAt, null, "not deleted");
      ctx.lacksFields(task, ["unknownField"], "task");
      if (authed) ctx.eq(task.userId, ctx.vars.userId, "assigned to the token user");
      else ctx.eq(task.userId, null, "ownerless with AUTH_MODE=none");
      ctx.vars.taskId = task.id;

      const bad = await ctx.post("/api/tasks", { title: "no" });
      ctx.status(bad, 400, "short title");
      ctx.error(bad, { meta: "required" });
      ctx.fieldErrors(bad, "title");
      const badType = await ctx.post("/api/tasks", { title: "Valid title", completed: "yes" });
      ctx.status(badType, 400, "completed coercion");
      const noTitle = await ctx.post("/api/tasks", {});
      ctx.status(noTitle, 400, "missing title");
    });

    await ctx.t(
      "get own task; include=user expands (basic/full) or is ignored (none)",
      async () => {
        const res = await ctx.get("/api/tasks/{{taskId}}?include=user");
        ctx.status(res, 200);
        ctx.envelope(res);
        ctx.eq(ctx.data(res).id, ctx.vars.taskId, "same task");
        if (authed) {
          const u = ctx.data(res).user;
          ctx.hasFields(u, ["id", "name", "email", "role"], "task.user");
          ctx.eq(u.id, ctx.vars.userId, "expanded user is the owner");
          ctx.lacksFields(u, ["password"], "task.user");
        } else {
          ctx.ok(
            ctx.data(res).user === undefined,
            "include=user must be ignored with AUTH_MODE=none",
          );
        }
      },
    );

    await ctx.t("foreign and missing tasks answer 404 on every verb", async () => {
      // task-1 belongs to the seeded admin: foreign in basic/full, owner-hidden in none
      const foreign = "task-1";
      const get = await ctx.get(`/api/tasks/${foreign}`);
      ctx.status(get, 404, "GET foreign");
      ctx.error(get);
      const put = await ctx.put(`/api/tasks/${foreign}`, { title: "Hijacked title" });
      ctx.status(put, 404, "PUT foreign");
      const del = await ctx.del(`/api/tasks/${foreign}`);
      ctx.status(del, 404, "DELETE foreign");
      const restore = await ctx.post(`/api/tasks/${foreign}/restore`, {});
      ctx.status(restore, 404, "restore foreign");
      const missing = await ctx.get("/api/tasks/11111111-2222-3333-4444-555555555555");
      ctx.status(missing, 404, "GET missing");
      const pattern = /^Task with ID '.*' not found\.$/;
      ctx.ok(pattern.test(get.body.message), `foreign GET message: ${get.body.message}`);
      ctx.eq(
        missing.body.message.replace("11111111-2222-3333-4444-555555555555", "<id>"),
        get.body.message.replace(foreign, "<id>"),
        "no existence oracle: same message shape",
      );
      if (authed) {
        // admins may read any task, but writes stay owner-only: task-3 belongs to ana, so it is
        // readable by the admin and still unwritable.
        const adminRead = await ctx.get(`/api/tasks/${foreign}`, { token: ctx.tokens.admin });
        ctx.status(adminRead, 200, "admin reads any task");
        const adminWrite = await ctx.put(
          "/api/tasks/task-3",
          { title: "Hijacked title" },
          { token: ctx.tokens.admin },
        );
        ctx.status(adminWrite, 404, "admin cannot write a foreign task");
        ctx.error(adminWrite);
        const adminDelete = await ctx.del("/api/tasks/task-3", { token: ctx.tokens.admin });
        ctx.status(adminDelete, 404, "admin cannot delete a foreign task");
        // the failed writes must not have touched it
        const intact = await ctx.get("/api/tasks/task-3", { token: ctx.tokens.user });
        ctx.status(intact, 200, "foreign task untouched");
        ctx.eq(ctx.data(intact).title, "Design Frontend UI", "title unchanged");
      }
    });

    await ctx.t("update own task; empty and invalid payloads → 400", async () => {
      const res = await ctx.put("/api/tasks/{{taskId}}", {
        completed: true,
        description: "updated by contract",
      });
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.eq(ctx.data(res).completed, true, "completed flipped");
      ctx.eq(ctx.data(res).description, "updated by contract", "description updated");
      const empty = await ctx.put("/api/tasks/{{taskId}}", {});
      ctx.status(empty, 400, "empty body");
      ctx.fieldErrors(empty, "_root");
      const badTitle = await ctx.put("/api/tasks/{{taskId}}", { title: "x" });
      ctx.status(badTitle, 400, "short title");
      ctx.fieldErrors(badTitle, "title");
    });

    await ctx.t("soft delete hides the task; includeDeleted reveals it", async () => {
      const del = await ctx.del("/api/tasks/{{taskId}}");
      ctx.status(del, 200);
      ctx.envelope(del);
      ctx.ok(ctx.data(del).deletedAt, "deletedAt set");
      const gone = await ctx.get("/api/tasks/{{taskId}}");
      ctx.status(gone, 404, "GET after soft delete");
      const list = await ctx.get("/api/tasks?limit=100");
      ctx.ok(!ctx.data(list).some((t) => t.id === ctx.vars.taskId), "hidden from default list");
      const withDeleted = await ctx.get("/api/tasks?includeDeleted=true&limit=100");
      ctx.status(withDeleted, 200, "includeDeleted=true list");
      const found = ctx.data(withDeleted).find((t) => t.id === ctx.vars.taskId);
      ctx.ok(found, "visible with includeDeleted=true");
      if (found) ctx.ok(found.deletedAt, "listed with deletedAt set");
      const readBack = await ctx.get("/api/tasks/{{taskId}}?includeDeleted=true");
      ctx.status(readBack, 200, "GET with includeDeleted=true");
      const put = await ctx.put("/api/tasks/{{taskId}}", { completed: false });
      ctx.status(put, 404, "PUT on soft-deleted task");
    });

    await ctx.t("restore brings it back; restoring a live task → 409", async () => {
      const res = await ctx.post("/api/tasks/{{taskId}}/restore", {});
      ctx.status(res, 200);
      ctx.envelope(res);
      ctx.eq(ctx.data(res).deletedAt, null, "deletedAt cleared");
      const again = await ctx.post("/api/tasks/{{taskId}}/restore", {});
      ctx.status(again, 409, "restore twice");
      ctx.error(again);
    });

    await ctx.t("permanent delete removes it for good", async () => {
      const del = await ctx.del("/api/tasks/{{taskId}}?permanent=true");
      ctx.status(del, 200);
      ctx.envelope(del);
      ctx.eq(ctx.data(del).id, ctx.vars.taskId, "deleted id echoed");
      ctx.eq(ctx.data(del).deletedPermanently, true, "deletedPermanently literal");
      const gone = await ctx.get("/api/tasks/{{taskId}}?includeDeleted=true");
      ctx.status(gone, 404, "gone even with includeDeleted");
    });

    await ctx.t("typed filters accept valid values and reject invalid ones", async () => {
      const fixture = await ctx.post("/api/tasks", {
        title: "Completed fixture task",
        completed: true,
      });
      ctx.status(fixture, 201, "completed fixture");
      const ok = await ctx.get("/api/tasks?filter[completed]=true&limit=100");
      ctx.status(ok, 200);
      ctx.ok(ctx.data(ok).length > 0, "filter[completed]=true matches rows");
      ctx.ok(
        ctx.data(ok).every((t) => t.completed === true),
        "every row completed",
      );
      const range = await ctx.get(
        "/api/tasks?filter[createdAt][gte]=2000-01-01T00:00:00.000Z&limit=5",
      );
      ctx.status(range, 200, "date range filter");
      const contains = await ctx.get("/api/tasks?filter[title][contains]=fixture&limit=100");
      ctx.status(contains, 200, "contains filter");
      ctx.ok(
        ctx.data(contains).every((t) => t.title.includes("fixture")),
        "contains honoured",
      );
      const badBool = await ctx.get("/api/tasks?filter[completed]=yes");
      ctx.status(badBool, 400, "bad boolean value");
      ctx.eq(
        badBool.body.message,
        "Invalid filter: 'completed' expects true or false",
        "boolean coercion message",
      );
      const badOp = await ctx.get("/api/tasks?filter[completed][gte]=abc");
      ctx.status(badOp, 400, "bad operator");
      ctx.eq(
        badOp.body.message,
        "Invalid filter: operator 'gte' is not supported for 'completed'",
        "operator message",
      );
      const badDate = await ctx.get("/api/tasks?filter[createdAt][gte]=nope");
      ctx.status(badDate, 400, "bad date value");
      const unknownField = await ctx.get("/api/tasks?filter[nonsense][eq]=1&limit=5");
      ctx.status(unknownField, 200, "unknown filter fields are ignored");
    });

    await ctx.t("search matches title and description; multi-field sort accepted", async () => {
      await ctx.post("/api/tasks", { title: "Quarterly report alpha" });
      await ctx.post("/api/tasks", {
        title: "Groceries for the week",
        description: "buy report paper",
      });
      const search = await ctx.get("/api/tasks?search=report&limit=100");
      ctx.status(search, 200);
      const titles = ctx.data(search).map((t) => t.title);
      ctx.ok(titles.includes("Quarterly report alpha"), "search hits the title");
      ctx.ok(titles.includes("Groceries for the week"), "search hits the description");
      const sorted = await ctx.get("/api/tasks?sort=-createdAt,title&limit=20");
      ctx.status(sorted, 200);
      const stamps = ctx.data(sorted).map((t) => t.createdAt);
      const ordered = [...stamps].sort().reverse();
      ctx.eq(JSON.stringify(stamps), JSON.stringify(ordered), "sorted by createdAt desc");
      const badSort = await ctx.get("/api/tasks?sortBy=bogus");
      ctx.status(badSort, 400, "invalid sortBy");
      ctx.fieldErrors(badSort, "sortBy");
    });

    await ctx.t("legacy completed=true filter and invalid value", async () => {
      const ok = await ctx.get("/api/tasks?completed=true&limit=100");
      ctx.status(ok, 200);
      ctx.ok(ctx.data(ok).length > 0, "completed=true matches rows");
      ctx.ok(
        ctx.data(ok).every((t) => t.completed === true),
        "every row completed",
      );
      const none = await ctx.get("/api/tasks?completed=false&limit=100");
      ctx.status(none, 200);
      ctx.ok(
        ctx.data(none).every((t) => t.completed === false),
        "every row not completed",
      );
      const bad = await ctx.get("/api/tasks?completed=maybe");
      ctx.status(bad, 400, "invalid completed value");
    });

    await ctx.t("admin scopes: userId= / scope=all (basic/full) or 400 (none)", async () => {
      if (authed) {
        const deniedUser = await ctx.get("/api/tasks?userId={{adminId}}", {
          token: ctx.tokens.user,
        });
        ctx.status(deniedUser, 403, "userId as regular user");
        ctx.eq(
          deniedUser.body.message,
          "Only administrators can list other users' tasks.",
          "403 message",
        );
        ctx.error(deniedUser);
        const deniedAll = await ctx.get("/api/tasks?scope=all", { token: ctx.tokens.user });
        ctx.status(deniedAll, 403, "scope=all as regular user");
        const byUser = await ctx.get("/api/tasks?userId={{userId}}&limit=100", {
          token: ctx.tokens.admin,
        });
        ctx.status(byUser, 200, "admin lists a user tasks");
        ctx.ok(ctx.data(byUser).length > 0, "the user has tasks");
        ctx.ok(
          ctx.data(byUser).every((t) => t.userId === ctx.vars.userId),
          "scoped to the requested user",
        );
        const all = await ctx.get("/api/tasks?scope=all&limit=100", { token: ctx.tokens.admin });
        ctx.status(all, 200, "admin lists everything");
        const owners = new Set(ctx.data(all).map((t) => t.userId));
        ctx.ok(owners.size > 1, `scope=all spans several owners (got ${owners.size})`);
      } else {
        const byUser = await ctx.get("/api/tasks?userId=user-1", { token: null });
        ctx.status(byUser, 400, "userId with AUTH_MODE=none");
        ctx.eq(
          byUser.body.message,
          "userId and scope=all need AUTH_MODE=basic or full.",
          "none-mode message",
        );
        ctx.error(byUser);
        const all = await ctx.get("/api/tasks?scope=all", { token: null });
        ctx.status(all, 400, "scope=all with AUTH_MODE=none");
      }
    });

    await ctx.t("the list is always scoped to the caller", async () => {
      const list = await ctx.get("/api/tasks?limit=100");
      ctx.status(list, 200);
      if (authed) {
        ctx.ok(
          ctx.data(list).every((t) => t.userId === ctx.vars.userId),
          "regular users only see their own tasks",
        );
      } else {
        ctx.ok(
          list.body.data.every((t) => t.userId === null),
          "public list is ownerless",
        );
        const ids = ctx.data(list).map((t) => t.id);
        ctx.ok(
          !ids.includes("task-1") && !ids.includes("task-2") && !ids.includes("task-3"),
          "user-owned seeded tasks stay hidden",
        );
      }
    });

    await ctx.t("task changes are audited (basic/full only)", async () => {
      if (!authed) return; // no audit reader is mounted with AUTH_MODE=none
      const res = await ctx.get("/api/audit-logs?entity=Task&limit=100", {
        token: ctx.tokens.admin,
      });
      ctx.status(res, 200);
      ctx.envelope(res);
      const actions = new Set(ctx.data(res).map((a) => a.action));
      for (const expected of ["CREATE", "UPDATE", "SOFT_DELETE", "RESTORE", "DELETE_PERMANENT"]) {
        ctx.ok(
          actions.has(expected),
          `audit must contain Task ${expected} (got: ${[...actions].join(",")})`,
        );
      }
      const sample = ctx.data(res).find((a) => a.action === "CREATE");
      ctx.hasFields(sample, ["id", "action", "entity", "entityId", "createdAt"], "audit entry");
      ctx.eq(sample.entity, "Task", "audit entity");
    });
  },
};
