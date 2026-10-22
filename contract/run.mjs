#!/usr/bin/env node
// Contract runner — replays the SAME executable scenarios against the frozen Hono
// baseline and the NestJS port, each with its own database.
//
//   node contract/run.mjs --base http://127.0.0.1:3911 --mode full --db /path/to.db
//
// Options:
//   --base  URL of the server under test (default http://127.0.0.1:3911)
//   --mode  full | basic | none   (must match the server's AUTH_MODE)
//   --db    path to the SQLite file (isolates rate-limit buckets between groups)
//   --group run a single group
//   CONTRACT_DUMP=<file>  write normalized transcript for cross-server diffing

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ctx } from "./lib.mjs";
import { startSmtpSink, resetRateLimitBuckets } from "./net.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};

const base = arg("base", "http://127.0.0.1:3911");
const mode = arg("mode", "full");
const dbPath = arg("db", null);
const only = arg("group", null);
const smtpPort = Number(arg("smtp", 2525));

if (!["full", "basic", "none"].includes(mode)) {
  console.error(`invalid --mode ${mode}`);
  process.exit(2);
}

const GROUP_ORDER = [
  "system",
  "mounting",
  "auth",
  "sessions",
  "tasks",
  "users",
  "audit",
  "recovery",
  "mfa",
  "ratelimit",
  "ratelimit-login",
];

const sink = startSmtpSink(smtpPort);
const ctx = new Ctx({ baseUrl: base, mode, dbPath });

const CREDS = {
  admin: ["admin@example.com", "password123"],
  user: ["ana@example.com", "password123"],
};

ctx.loginAs = async (persona, password) => {
  const [email, pwd] = CREDS[persona] || [];
  const res = await ctx.post(
    "/api/auth/login",
    { email: email || persona, password: password || pwd },
    { token: null },
  );
  if (res.status !== 200) {
    throw new Error(`login ${persona} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  ctx.tokens[persona] = res.body.accessToken;
  ctx.vars[`${persona}Id`] = res.body.user.id;
  ctx.vars[`${persona}SessionId`] = res.body.sessionId;
  ctx.vars[`${persona}Role`] = res.body.user.role;
  ctx.token = res.body.accessToken;
  return res;
};

ctx.as = (persona) => {
  ctx.token = persona ? ctx.tokens[persona] || null : null;
};

/** Register a throwaway account (consumes the 5/h register budget — use sparingly). */
ctx.registerTmp = async (prefix = "contract") => {
  const email = `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = "TmpPass123!";
  const res = await ctx.post(
    "/api/auth/register",
    { name: `Tmp ${prefix}`, email, password },
    { token: null },
  );
  if (res.status !== 201)
    throw new Error(`register tmp failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  ctx.vars.tmpEmail = email;
  ctx.vars.tmpPassword = password;
  ctx.vars.tmpUserId = res.body.data ? res.body.data.id : res.body.id;
  return { email, password, id: ctx.vars.tmpUserId };
};

const started = Date.now();
console.log(`contract: base=${base} mode=${mode}${dbPath ? ` db=${dbPath}` : ""} smtp=${smtpPort}`);

for (const name of GROUP_ORDER) {
  if (only && name !== only) continue;
  let mod;
  try {
    mod = await import(path.join(here, "scenarios", `${name}.mjs`));
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") continue;
    throw err;
  }
  const sc = mod.default;
  if (sc.modes && !sc.modes.includes(mode)) {
    console.log(`  ○ ${name} (skipped in mode=${mode})`);
    continue;
  }
  // Isolate rate-limit budget per group (harness-only; the server keeps serving).
  await resetRateLimitBuckets(dbPath);
  ctx.groupName = name;
  const before = ctx.results.length;
  await ctx.t(`group:${name}`, () => sc.run(ctx));
  const groupFails = ctx.results.slice(before).filter((r) => !r.ok).length;
  console.log(
    `  ${groupFails ? "✗" : "✓"} ${name} (${ctx.results.slice(before).length} tests${groupFails ? `, ${groupFails} FAILED` : ""})`,
  );
}

// ------------------------------------------------------------------ report
const results = ctx.results.filter((r) => !r.group || !r.name.startsWith("group:"));
const failed = results.filter((r) => !r.ok);
const strays = ctx.results.filter((r) => r.name.startsWith("group:") && !r.ok);
let code = failed.length || strays.length ? 1 : 0;

console.log(
  `\ncontract: ${results.length} tests, ${failed.length + strays.length} failing (${Date.now() - started}ms, mode=${mode})`,
);
for (const r of [...failed, ...strays]) {
  console.log(`\n  ✗ [${r.group}] ${r.name}`);
  for (const f of r.fails) console.log(`      - ${f}`);
}

if (process.env.CONTRACT_DUMP) {
  fs.writeFileSync(process.env.CONTRACT_DUMP, JSON.stringify(ctx.transcript, null, 2));
  console.log(`\ntranscript → ${process.env.CONTRACT_DUMP}`);
}

await sink.close();
process.exit(code);
