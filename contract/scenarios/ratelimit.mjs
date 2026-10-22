// Group: ratelimit — HTTP rate limits that need no successful login afterwards:
// refresh (30/min), register (5/h) and forgot-password (10/h). The runner resets every
// bucket before the group, so the budget is exactly one fresh window per limiter.
//
// All three share one response contract: 429 + error envelope + X-RateLimit-Limit /
// X-RateLimit-Remaining + Retry-After (and a top-level retryAfterSeconds).
export default {
  name: "ratelimit",
  modes: ["basic", "full"],
  async run(ctx) {
    const assert429 = (res, limit, label) => {
      ctx.status(res, 429, label);
      ctx.contentType(res, "application/json", `${label} content-type`);
      ctx.error(res, { meta: "required" });
      ctx.eq(
        res.body.message,
        "Too many requests. Please slow down and try again later.",
        `${label} message`,
      );
      ctx.ok(!("data" in res.body), `${label} must not carry data`);
      ctx.ok(
        typeof res.body.retryAfterSeconds === "number" && res.body.retryAfterSeconds >= 1,
        `${label} retryAfterSeconds: ${res.body.retryAfterSeconds}`,
      );
      ctx.eq(res.headers["x-ratelimit-limit"], String(limit), `${label} X-RateLimit-Limit`);
      ctx.eq(res.headers["x-ratelimit-remaining"], "0", `${label} X-RateLimit-Remaining`);
      const retryAfter = Number(res.headers["retry-after"]);
      ctx.ok(
        Number.isFinite(retryAfter) && retryAfter >= 1,
        `${label} Retry-After: ${res.headers["retry-after"]}`,
      );
    };

    await ctx.t("refresh: 30/min per IP ends in 429 with rate-limit headers", async () => {
      let first = null;
      let lastOk = null;
      let limited = null;
      for (let i = 0; i < 35; i++) {
        const res = await ctx.post(
          "/api/auth/refresh",
          { refreshToken: "garbage-token" },
          { token: null },
        );
        if (res.status === 429) {
          limited = res;
          break;
        }
        if (!first) first = res;
        lastOk = res;
        ctx.ok(
          res.status === 401,
          `attempt ${i + 1}: expected 401 before the limit, got ${res.status}`,
        );
      }
      ctx.ok(limited, "a 429 must be observed within 35 refresh attempts");
      if (!limited) return;
      assert429(limited, 30, "refresh 429");
      ctx.ok(first, "some request passed before the limit");
      if (first) {
        ctx.eq(first.headers["x-ratelimit-limit"], "30", "X-RateLimit-Limit on allowed requests");
        ctx.ok(
          Number(first.headers["x-ratelimit-remaining"]) > 0,
          `remaining starts above zero: ${first.headers["x-ratelimit-remaining"]}`,
        );
      }
      if (lastOk) {
        ctx.eq(
          lastOk.headers["x-ratelimit-remaining"],
          "0",
          "the last allowed request reports remaining 0",
        );
      }
    });

    await ctx.t("register: 5/h per IP ends in 429 (failed attempts count)", async () => {
      let limited = null;
      let allowed = 0;
      for (let i = 0; i < 6; i++) {
        // invalid payloads: they still hit the limiter and create no accounts
        const res = await ctx.post("/api/auth/register", {}, { token: null });
        if (res.status === 429) {
          limited = res;
          break;
        }
        allowed++;
        ctx.ok(res.status === 400, `attempt ${i + 1}: expected 400 validation, got ${res.status}`);
      }
      ctx.ok(limited, "a 429 must be observed within 6 register attempts");
      if (!limited) return;
      ctx.eq(allowed, 5, "exactly 5 requests are allowed per window");
      assert429(limited, 5, "register 429");
    });

    if (ctx.mode === "full") {
      await ctx.t("forgot-password: 10/h per IP ends in 429", async () => {
        let limited = null;
        let allowed = 0;
        const email = `ratelimit-nobody-${Math.random().toString(36).slice(2, 8)}@example.com`;
        for (let i = 0; i < 12; i++) {
          const res = await ctx.post("/api/auth/forgot-password", { email }, { token: null });
          if (res.status === 429) {
            limited = res;
            break;
          }
          allowed++;
          ctx.ok(res.status === 202, `attempt ${i + 1}: expected 202, got ${res.status}`);
        }
        ctx.ok(limited, "a 429 must be observed within 12 forgot-password attempts");
        if (!limited) return;
        ctx.eq(allowed, 10, "exactly 10 requests are allowed per window");
        assert429(limited, 10, "forgot-password 429");
      });
    }

    await ctx.t("rate-limited endpoints stay JSON and never leak internals", async () => {
      // the register limiter is still exhausted inside this group: a free way to re-check
      const res = await ctx.post("/api/auth/register", {}, { token: null });
      ctx.status(res, 429);
      ctx.contentType(res, "application/json");
      ctx.ok(res.body.error === undefined, "no raw error field");
      ctx.ok(res.body.stack === undefined, "no stack trace");
      ctx.ok(!!res.headers["x-request-id"], "x-request-id present on 429");
      ctx.ok(
        !!res.headers["x-response-time"] || !!res.headers["server-timing"],
        "timing headers present on 429",
      );
    });
  },
};
