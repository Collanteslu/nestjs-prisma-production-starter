// Group: mounting — AUTH_MODE parity: unmounted modules must 404, disappear from
// the OpenAPI document and from the GET / index (README "Authentication Modes").
export default {
  name: "mounting",
  modes: ["none", "basic", "full"],
  async run(ctx) {
    const openapi = await ctx.get("/openapi.json");
    const paths = (openapi.body && openapi.body.paths) || {};
    const index = await ctx.get("/");
    const idxEndpoints = (index.body && index.body.endpoints) || {};
    const schemes =
      openapi.body?.components?.securitySchemes || openapi.body?.securityDefinitions || {};

    const has = (p) => paths[p] !== undefined;
    const hasPathStart = (prefix) => Object.keys(paths).some((p) => p.startsWith(prefix));

    await ctx.t("health + docs always mounted", async () => {
      ctx.ok(has("/healthz"), "/healthz missing from spec");
      ctx.ok(hasPathStart("/api/tasks"), "/api/tasks missing from spec");
    });

    if (ctx.mode === "none") {
      await ctx.t("none: auth/users/sessions/audit endpoints are absent from spec", async () => {
        ctx.ok(
          !hasPathStart("/api/auth"),
          `spec must not document /api/auth (paths: ${Object.keys(paths).join(",")})`,
        );
        ctx.ok(!hasPathStart("/api/users"), "spec must not document /api/users");
        ctx.ok(!hasPathStart("/api/sessions"), "spec must not document /api/sessions");
        ctx.ok(!hasPathStart("/api/audit-logs"), "spec must not document /api/audit-logs");
        ctx.ok(
          schemes.BearerAuth === undefined,
          "spec must not declare BearerAuth security scheme",
        );
      });

      await ctx.t("none: unmounted routes answer 404", async () => {
        for (const [method, path] of [
          ["POST", "/api/auth/register"],
          ["POST", "/api/auth/login"],
          ["POST", "/api/auth/refresh"],
          ["POST", "/api/auth/logout"],
          ["GET", "/api/sessions/me"],
          ["GET", "/api/users"],
          ["GET", "/api/audit-logs"],
        ]) {
          const res = await ctx.req(method, path, { body: {}, token: null });
          ctx.status(res, 404, `${method} ${path}`);
        }
      });

      await ctx.t("none: index reports authMode and hides auth endpoints", async () => {
        ctx.eq(index.body.authMode, "none", "index.authMode");
        ctx.ok(
          !("auth" in idxEndpoints),
          `index.endpoints must not have "auth": ${Object.keys(idxEndpoints).join(",")}`,
        );
      });

      await ctx.t("none: tasks are public (no bearer needed)", async () => {
        const res = await ctx.get("/api/tasks", { token: null });
        ctx.status(res, 200);
        ctx.envelope(res);
      });
    }

    if (ctx.mode === "basic" || ctx.mode === "full") {
      await ctx.t("basic/full: BearerAuth declared in spec", async () => {
        ctx.ok(schemes.BearerAuth !== undefined, "BearerAuth security scheme missing");
      });

      await ctx.t("basic/full: auth/users/sessions/audit mounted", async () => {
        for (const p of [
          "/api/auth/register",
          "/api/auth/login",
          "/api/auth/refresh",
          "/api/auth/logout",
          "/api/sessions/me",
          "/api/users",
          "/api/audit-logs",
        ]) {
          ctx.ok(has(p), `${p} missing from spec`);
        }
        ctx.ok("auth" in idxEndpoints, "index.endpoints.auth missing");
      });
    }

    if (ctx.mode === "basic") {
      await ctx.t("basic: account-security endpoints are absent from spec", async () => {
        for (const p of [
          "/api/auth/forgot-password",
          "/api/auth/reset-password",
          "/api/auth/verify-email",
          "/api/auth/resend-verification",
          "/api/auth/mfa/setup",
          "/api/auth/mfa/enable",
          "/api/auth/mfa/disable",
        ]) {
          ctx.ok(!has(p), `${p} must not be documented in basic mode`);
        }
      });

      await ctx.t("basic: account-security routes answer 404", async () => {
        for (const [method, path] of [
          ["POST", "/api/auth/forgot-password"],
          ["POST", "/api/auth/reset-password"],
          ["POST", "/api/auth/verify-email"],
          ["POST", "/api/auth/resend-verification"],
          ["POST", "/api/auth/mfa/setup"],
          ["POST", "/api/auth/mfa/enable"],
          ["POST", "/api/auth/mfa/disable"],
          ["DELETE", "/api/users/user-1/mfa"],
        ]) {
          const res = await ctx.req(method, path, {
            body: { token: "x", password: "x".repeat(10) },
            token: null,
          });
          ctx.status(res, 404, `${method} ${path}`);
        }
      });

      await ctx.t("basic: index hides account-security endpoints", async () => {
        const text = JSON.stringify(idxEndpoints);
        ctx.ok(
          !/forgotPassword|mfa|verifyEmail/i.test(text),
          `index.endpoints leaks account security: ${text.slice(0, 300)}`,
        );
      });
    }

    if (ctx.mode === "full") {
      await ctx.t("full: account-security endpoints documented", async () => {
        for (const p of [
          "/api/auth/forgot-password",
          "/api/auth/reset-password",
          "/api/auth/verify-email",
          "/api/auth/resend-verification",
          "/api/auth/mfa/setup",
          "/api/auth/mfa/enable",
          "/api/auth/mfa/disable",
        ]) {
          ctx.ok(has(p), `${p} missing from spec in full mode`);
        }
      });

      await ctx.t("full: spec documents security on protected routes", async () => {
        const secured = paths["/api/tasks"]?.get?.security;
        ctx.ok(
          Array.isArray(secured) && secured.some((s) => s.BearerAuth),
          `/api/tasks security: ${JSON.stringify(secured)}`,
        );
      });
    }
  },
};
