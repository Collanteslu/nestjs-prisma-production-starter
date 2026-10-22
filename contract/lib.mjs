// Contract harness — client, assertions and normalization.
// Fixtures are executable specs: they must be GREEN against the frozen Hono baseline
// (origin SHA 644a5d2) and GREEN against the NestJS port. Same scenarios, same expectations.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const VAR_KEYS = new Set([
  "requestId",
  "durationMs",
  "timestamp",
  "uptimeSeconds",
  "latencyMs",
  "retryAfterSeconds",
  "accessToken",
  "refreshToken",
  "token",
  "secret",
  "otpauthUrl",
]);

/** Deep-normalize variable values so two servers can be diffed. */
export function normalize(value) {
  if (typeof value === "string") {
    return value.replace(JWT_RE, "<jwt>").replace(UUID_RE, "<uuid>").replace(ISO_RE, "<date>");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VAR_KEYS.has(k)) {
        out[k] = typeof v === "number" ? "<num>" : "<var>";
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

export function deepMatch(actual, expected, path = "$") {
  const diffs = [];
  const walk = (a, e, p) => {
    if (e === undefined) return;
    if (e === null) {
      if (a !== null) diffs.push(`${p}: expected null, got ${JSON.stringify(a)}`);
      return;
    }
    if (typeof e === "object" && !Array.isArray(e)) {
      if (typeof a !== "object" || a === null || Array.isArray(a)) {
        diffs.push(`${p}: expected object, got ${JSON.stringify(a)}`);
        return;
      }
      for (const [k, v] of Object.entries(e)) walk(a[k], v, `${p}.${k}`);
      return;
    }
    if (Array.isArray(e)) {
      if (!Array.isArray(a)) {
        diffs.push(`${p}: expected array, got ${JSON.stringify(a)}`);
        return;
      }
      if (a.length !== e.length) diffs.push(`${p}: expected length ${e.length}, got ${a.length}`);
      e.forEach((item, i) => walk(a[i], item, `${p}[${i}]`));
      return;
    }
    if (typeof e === "string" && typeof a === "string" && e.startsWith("~")) {
      // "~regex" style loose match: value must match the rest of the string as regex
      const re = new RegExp(e.slice(1));
      if (!re.test(a)) diffs.push(`${p}: "${a}" !~ /${e.slice(1)}/`);
      return;
    }
    if (!Object.is(a, e))
      diffs.push(`${p}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  };
  walk(actual, expected, path);
  return diffs;
}

export class Ctx {
  constructor({ baseUrl, mode, dbPath = null, dump = null }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.mode = mode;
    this.dbPath = dbPath;
    this.dump = dump;
    this.vars = {};
    this.results = [];
    this.fails = [];
    this.groupName = null;
    this.transcript = [];
    this.token = null; // default bearer (persona currently logged in)
    this.tokens = {};
    this.outbox = null; // SMTP sink, installed by runner
  }

  tmpl(v) {
    if (typeof v === "string") {
      return v.replace(/\{\{([\w.[\]-]+)\}\}/g, (_, k) => {
        const val = this.vars[k];
        if (val === undefined) throw new Error(`undefined contract var: ${k}`);
        return String(val);
      });
    }
    if (Array.isArray(v)) return v.map((x) => this.tmpl(x));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.tmpl(x);
      return out;
    }
    return v;
  }

  async req(method, path, opts = {}) {
    const url = this.baseUrl + this.tmpl(path);
    const headers = { ...(opts.headers || {}) };
    let body;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      headers["content-type"] = headers["content-type"] || "application/json";
    } else if (opts.body !== undefined) {
      body = JSON.stringify(this.tmpl(opts.body));
      headers["content-type"] = headers["content-type"] || "application/json";
    }
    const token = opts.token !== undefined ? opts.token : this.token;
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(url, { method, headers, body, redirect: "manual" });
    } catch (err) {
      throw new Error(`request failed: ${method} ${url}: ${err.message}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html or plain text */
    }
    const out = {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: json,
      text,
      contentType: res.headers.get("content-type") || "",
    };
    this.transcript.push({
      method,
      path: this.tmpl(path),
      status: out.status,
      body: normalize(json !== null ? json : text),
    });
    return out;
  }

  get(path, opts) {
    return this.req("GET", path, opts);
  }
  post(path, body, opts = {}) {
    return this.req("POST", path, { ...opts, body });
  }
  put(path, body, opts = {}) {
    return this.req("PUT", path, { ...opts, body });
  }
  patch(path, body, opts = {}) {
    return this.req("PATCH", path, { ...opts, body });
  }
  del(path, opts = {}) {
    return this.req("DELETE", path, opts);
  }

  async t(name, fn) {
    const before = this.fails.length;
    try {
      await fn();
    } catch (err) {
      this.fails.push(`threw: ${err && err.message ? err.message : String(err)}`);
    }
    const fails = this.fails.splice(before);
    this.results.push({ group: this.groupName, name, ok: fails.length === 0, fails });
  }

  // ---------- assertions (push into current test) ----------

  ok(cond, label) {
    if (!cond) this.fails.push(label);
  }

  eq(actual, expected, label) {
    if (!Object.is(actual, expected)) {
      this.fails.push(
        `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  status(res, expected, label = "status") {
    if (res.status !== expected) {
      const body = typeof res.body === "string" ? res.body.slice(0, 400) : JSON.stringify(res.body);
      this.fails.push(`${label}: expected HTTP ${expected}, got ${res.status} — ${body}`);
    }
  }

  contentType(res, part, label = "content-type") {
    if (!res.contentType.includes(part)) {
      this.fails.push(`${label}: expected "${part}" in "${res.contentType}"`);
    }
  }

  /** success envelope: {success:true, message?, data, pagination?, meta} */
  envelope(res, { meta = true } = {}) {
    const b = res.body;
    if (!b || typeof b !== "object") {
      this.fails.push(`envelope: body is not an object (${typeof b})`);
      return;
    }
    this.eq(b.success, true, "envelope.success");
    if (meta) {
      const m = b.meta;
      if (!m || typeof m !== "object") {
        this.fails.push("envelope.meta missing");
      } else {
        this.ok(
          typeof m.requestId === "string" && m.requestId.length >= 8,
          `meta.requestId: ${m.requestId}`,
        );
        this.ok(
          typeof m.timestamp === "string" && /\d{4}-\d{2}-\d{2}T/.test(m.timestamp),
          `meta.timestamp: ${m.timestamp}`,
        );
        this.ok(
          typeof m.durationMs === "number",
          `meta.durationMs: ${JSON.stringify(m.durationMs)}`,
        );
        this.ok(
          typeof m.apiVersion === "string" && m.apiVersion.length > 0,
          `meta.apiVersion: ${m.apiVersion}`,
        );
      }
    }
  }

  /** error envelope: {success:false, message, errors?} */
  error(res, { meta = "any" } = {}) {
    const b = res.body;
    if (!b || typeof b !== "object") {
      this.fails.push(
        `error envelope: body is not an object (${typeof b}): ${res.text?.slice(0, 200)}`,
      );
      return;
    }
    this.eq(b.success, false, "error.success");
    this.ok(
      typeof b.message === "string" && b.message.length > 0,
      `error.message: ${JSON.stringify(b.message)}`,
    );
    if (meta === "none")
      this.ok(b.meta === undefined, `error.meta should be absent, got ${JSON.stringify(b.meta)}`);
    if (meta === "required")
      this.ok(b.meta && typeof b.meta === "object", "error.meta required but missing");
  }

  fieldErrors(res, field) {
    const errs = res.body && res.body.errors;
    if (!errs || typeof errs !== "object") {
      this.fails.push(
        `fieldErrors: no errors object in ${JSON.stringify(res.body)?.slice(0, 300)}`,
      );
      return;
    }
    const list = errs[field];
    this.ok(
      Array.isArray(list) && list.length > 0,
      `fieldErrors[${field}]: ${JSON.stringify(list)}`,
    );
    if (Array.isArray(list)) {
      this.ok(
        list.every((m) => typeof m === "string" && m.length > 0),
        `fieldErrors[${field}] all non-empty strings: ${JSON.stringify(list)}`,
      );
    }
  }

  pagination(res, { page = 1, limit } = {}) {
    const p = res.body && res.body.pagination;
    if (!p || typeof p !== "object") {
      this.fails.push(`pagination missing: ${JSON.stringify(res.body)?.slice(0, 200)}`);
      return;
    }
    this.eq(p.page, page, "pagination.page");
    if (limit !== undefined) this.eq(p.limit, limit, "pagination.limit");
    for (const k of ["total", "totalPages"])
      this.ok(typeof p[k] === "number", `pagination.${k}: ${p[k]}`);
    for (const k of ["hasNextPage", "hasPrevPage"])
      this.ok(typeof p[k] === "boolean", `pagination.${k}: ${p[k]}`);
  }

  data(res) {
    return res.body && res.body.data;
  }

  hasFields(obj, fields, label = "fields") {
    if (!obj || typeof obj !== "object") {
      this.fails.push(`${label}: not an object: ${JSON.stringify(obj)?.slice(0, 200)}`);
      return;
    }
    for (const f of fields) {
      this.ok(
        Object.prototype.hasOwnProperty.call(obj, f),
        `${label}: missing field "${f}" (got ${Object.keys(obj).join(",")})`,
      );
    }
  }

  lacksFields(obj, fields, label = "fields") {
    if (!obj || typeof obj !== "object") return;
    for (const f of fields) {
      this.ok(
        !Object.prototype.hasOwnProperty.call(obj, f),
        `${label}: field "${f}" must not be exposed`,
      );
    }
  }

  isUuid(v, label = "uuid") {
    this.ok(typeof v === "string" && UUID_RE.test(v), `${label}: ${v}`);
    UUID_RE.lastIndex = 0;
  }

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }
}

export function uuid() {
  return crypto.randomUUID();
}

export function randomEmail(prefix = "contract") {
  return `${prefix}-${uuid().slice(0, 8)}@example.com`;
}
