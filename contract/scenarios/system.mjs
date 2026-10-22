// Group: system — index, health, docs, request id, body limit, CORS, malformed JSON.
export default {
  name: "system",
  modes: ["none", "basic", "full"],
  async run(ctx) {
    const authUrl = ctx.mode === "none" ? "/api/tasks" : "/api/auth/login";

    await ctx.t("GET / index (no envelope, reports mode)", async () => {
      const res = await ctx.get("/");
      ctx.status(res, 200);
      ctx.contentType(res, "application/json");
      ctx.ok(res.body.success === undefined, "index must not use the general envelope");
      ctx.hasFields(res.body, ["status", "name", "version", "authMode", "endpoints"], "index");
      ctx.eq(res.body.status, "online", "index.status");
      ctx.eq(res.body.authMode, ctx.mode, "index.authMode");
      ctx.ok(typeof res.body.version === "string" && res.body.version.length > 0, "index.version");
      ctx.ok(
        typeof res.body.endpoints === "object" && Object.keys(res.body.endpoints).length > 0,
        "index.endpoints",
      );
    });

    await ctx.t("GET /healthz deep check (no envelope)", async () => {
      const res = await ctx.get("/healthz");
      ctx.status(res, 200);
      ctx.contentType(res, "application/json");
      ctx.ok(res.body.success === undefined, "healthz must not use the general envelope");
      ctx.hasFields(res.body, ["status", "uptimeSeconds", "database"], "healthz");
      ctx.ok(
        typeof res.body.uptimeSeconds === "number",
        `healthz.uptimeSeconds: ${res.body.uptimeSeconds}`,
      );
      ctx.hasFields(res.body.database, ["latencyMs"], "healthz.database");
      ctx.ok(
        typeof res.body.database.latencyMs === "number",
        `healthz.database.latencyMs: ${res.body.database.latencyMs}`,
      );
    });

    await ctx.t("GET /openapi.json is a valid OpenAPI 3 document", async () => {
      const res = await ctx.get("/openapi.json");
      ctx.status(res, 200);
      ctx.contentType(res, "application/json");
      ctx.ok(
        typeof res.body.openapi === "string" && res.body.openapi.startsWith("3."),
        `openapi: ${res.body.openapi}`,
      );
      ctx.hasFields(res.body, ["info", "paths"], "openapi");
      ctx.ok(
        typeof res.body.paths === "object" && Object.keys(res.body.paths).length > 0,
        "openapi.paths non-empty",
      );
      ctx.ok(
        typeof res.body.info.title === "string" && res.body.info.title.length > 0,
        "openapi.info.title",
      );
      ctx.ok(typeof res.body.info.version === "string", "openapi.info.version");
      ctx.ok(res.body.paths["/healthz"] !== undefined, "openapi must document /healthz");
      ctx.ok(res.body.paths["/api/tasks"] !== undefined, "openapi must document /api/tasks");
    });

    await ctx.t("GET /docs serves HTML", async () => {
      const res = await ctx.get("/docs");
      ctx.status(res, 200);
      ctx.contentType(res, "text/html");
      ctx.ok(res.text.length > 500, `/docs html too small: ${res.text.length}`);
    });

    await ctx.t("unknown route → 404 error envelope", async () => {
      const res = await ctx.get("/definitely-not-a-route");
      ctx.status(res, 404);
      ctx.contentType(res, "application/json");
      ctx.error(res);
    });

    await ctx.t("X-Request-Id is generated and echoed when valid", async () => {
      const auto = await ctx.get("/healthz");
      ctx.ok(
        typeof auto.headers["x-request-id"] === "string" &&
          auto.headers["x-request-id"].length >= 8,
        `x-request-id missing: ${auto.headers["x-request-id"]}`,
      );
      const echoed = await ctx.get("/healthz", { headers: { "x-request-id": "contract-echo.42" } });
      ctx.eq(echoed.headers["x-request-id"], "contract-echo.42", "x-request-id echo");
      const rejected = await ctx.get("/healthz", {
        headers: { "x-request-id": "bad id with spaces!" },
      });
      ctx.ok(
        rejected.headers["x-request-id"] !== "bad id with spaces!",
        `invalid x-request-id must be replaced, got ${rejected.headers["x-request-id"]}`,
      );
      ctx.ok(
        /[0-9a-f-]{36}/.test(rejected.headers["x-request-id"] || ""),
        `replacement should be a uuid: ${rejected.headers["x-request-id"]}`,
      );
    });

    await ctx.t("timing headers (X-Response-Time, Server-Timing)", async () => {
      const res = await ctx.get("/healthz");
      ctx.ok(
        /ms$/.test(res.headers["x-response-time"] || ""),
        `x-response-time: ${res.headers["x-response-time"]}`,
      );
      ctx.ok(
        /total;dur=\d/.test(res.headers["server-timing"] || ""),
        `server-timing: ${res.headers["server-timing"]}`,
      );
    });

    await ctx.t(
      "timing headers also on error responses (guards run after request id)",
      async () => {
        const res = await ctx.get("/api/tasks", { token: null });
        ctx.status(res, 401);
        ctx.ok(!!res.headers["x-request-id"], "x-request-id must exist on 401");
        ctx.ok(
          !!res.headers["server-timing"] || !!res.headers["x-response-time"],
          "timing headers must exist on 401",
        );
      },
    );

    await ctx.t("CORS preflight allows configured origin", async () => {
      const res = await ctx.req("OPTIONS", "/api/tasks", {
        headers: {
          origin: "http://contract.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,authorization",
        },
        token: null,
      });
      ctx.ok(res.status >= 200 && res.status < 300, `preflight status: ${res.status}`);
      ctx.ok(
        res.headers["access-control-allow-origin"] === "http://contract.example" ||
          res.headers["access-control-allow-origin"] === "*",
        `access-control-allow-origin: ${res.headers["access-control-allow-origin"]}`,
      );
      ctx.ok(
        (res.headers["access-control-allow-headers"] || "").toLowerCase().includes("authorization"),
        `allow-headers: ${res.headers["access-control-allow-headers"]}`,
      );
    });

    await ctx.t("malformed JSON → 400 error envelope", async () => {
      const res = await ctx.req("POST", authUrl, { rawBody: '{"broken": ', token: null });
      ctx.status(res, 400);
      ctx.contentType(res, "application/json");
      ctx.error(res, { meta: "required" });
      ctx.eq(res.body.message, "Malformed JSON in request body", "malformed JSON message");
    });

    await ctx.t("body over 100 KiB → 413 error envelope", async () => {
      const big = JSON.stringify({ padding: "x".repeat(100 * 1024 + 64) });
      const res = await ctx.req("POST", authUrl, { rawBody: big, token: null });
      ctx.status(res, 413);
      ctx.contentType(res, "application/json");
      ctx.error(res, { meta: "required" });
      ctx.eq(
        res.body.message,
        "Payload Too Large: Request body exceeds the maximum permitted limit of 100 KB.",
        "413 message",
      );
    });

    await ctx.t("empty JSON body on POST → 400 error envelope", async () => {
      const res = await ctx.req("POST", authUrl, { rawBody: "", token: null });
      ctx.ok(
        res.status === 400 || res.status === 415,
        `expected 400 (or 415), got ${res.status}: ${res.text.slice(0, 200)}`,
      );
      ctx.contentType(res, "application/json");
      ctx.error(res);
    });
  },
};
