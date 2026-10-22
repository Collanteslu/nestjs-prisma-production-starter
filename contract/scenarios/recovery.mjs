// Group: recovery — password reset and email verification, driven end to end through the
// captured mailbox. Every flow answers the same way whether or not the account exists, so the
// tests assert on the *email* (and on the single-use token inside it) rather than on the body.
//
// The runner starts an SMTP sink (`startSmtpSink`) but never assigns it to `ctx.outbox`
// (see contract/lib.mjs, where it is declared as "installed by runner"). Until that one line
// lands in run.mjs, this group binds the port the server actually delivers to (2525) itself;
// run the harness with `--smtp 2526` so the runner's own sink does not take the port first.
import net from "node:net";
import { startSmtpSink } from "../net.mjs";

const SMTP_PORT = Number(process.env.CONTRACT_SMTP_PORT || 2525);
const TOKEN_RE = /[?&]token=([A-Za-z0-9_-]{20,})/;

/**
 * Decode a quoted-printable body (what nodemailer emits for text/plain) back to UTF-8.
 * Handles soft line breaks ("=\r\n") and =XX escapes, e.g. `token=3Dabc` → `token=abc`.
 */
function qpDecode(text) {
  const chunks = [];
  let ascii = "";
  const flush = () => {
    if (ascii) {
      chunks.push(Buffer.from(ascii, "utf8"));
      ascii = "";
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "=") {
      if (text[i + 1] === "\r" && text[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (text[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-F]{2}$/i.test(hex)) {
        flush();
        chunks.push(Buffer.from([parseInt(hex, 16)]));
        i += 2;
        continue;
      }
    }
    ascii += ch;
  }
  flush();
  return Buffer.concat(chunks).toString("utf8");
}

/** Subject header out of the raw MIME payload (unfolded and QP-decoded, like the body). */
function subjectOf(message) {
  const headers = message.data.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const line = headers.split(/\r?\n/).find((h) => /^subject:/i.test(h));
  return line ? qpDecode(line.replace(/^subject:\s*/i, "")).trim() : null;
}

/** Wait until the Nth message (by capture order) matching `re` lands, and return its decoded body. */
async function waitForNew(outbox, since, re, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    for (let i = since; i < outbox.messages.length; i += 1) {
      const hit = outbox.messages[i].data.match(re);
      if (hit) {
        return {
          index: i,
          message: outbox.messages[i],
          body: qpDecode(outbox.messages[i].data),
          subject: subjectOf(outbox.messages[i]),
        };
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout (${timeoutMs}ms) waiting for email matching ${re}; captured ${outbox.messages.length - since} new message(s)`,
      );
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Poll an audit count until it reaches `expected` — `recordAudit` runs just after the SMTP hand-off. */
async function auditCount(ctx, token, query, expected = 1) {
  const deadline = Date.now() + 5000;
  let seen = 0;
  for (;;) {
    const res = await ctx.get(`/api/audit-logs?limit=100&${query}`, { token });
    if (res.status === 200) seen = (res.body.data || []).length;
    if (seen >= expected || Date.now() > deadline) return seen;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Fail loudly (with the fix) instead of silently capturing nothing. */
async function claimOutbox(ctx) {
  if (ctx.outbox) return { outbox: ctx.outbox, close: null };
  const probe = await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(null));
    s.listen(SMTP_PORT, "127.0.0.1", () => s.close(() => resolve("free")));
  });
  if (probe !== "free") {
    throw new Error(
      `no SMTP capture available: ctx.outbox is not installed by the runner and port ${SMTP_PORT} is already ` +
        `bound (the runner's own sink). Re-run the harness with \`--smtp 2526\` so this group can bind ` +
        `${SMTP_PORT}, or add \`ctx.outbox = sink;\` to contract/run.mjs.`,
    );
  }
  const sink = startSmtpSink(SMTP_PORT);
  return { outbox: sink, close: () => sink.close() };
}

export default {
  name: "recovery",
  modes: ["full"],
  async run(ctx) {
    const { outbox, close } = await claimOutbox(ctx);
    const mark = () => outbox.messages.length;
    // Background sends race the response, so every "expect silence" check pins the count captured
    // *before* its request and then waits out the delivery window.
    const noEmail = async (since, label) => {
      await ctx.sleep(900);
      ctx.eq(outbox.messages.length, since, `${label}: no email must be sent`);
    };

    try {
      // ---------------------------------------------------------- validation first
      await ctx.t(
        "forgot-password validates the payload and never reveals the account",
        async () => {
          const bad = await ctx.post(
            "/api/auth/forgot-password",
            { email: "not-an-email" },
            { token: null },
          );
          ctx.status(bad, 400);
          ctx.error(bad);
          ctx.fieldErrors(bad, "email");

          // Unknown address: identical 202 to a real one (no enumeration), and nothing is sent.
          const since = mark();
          const unknown = await ctx.post(
            "/api/auth/forgot-password",
            { email: `ghost-${Math.random().toString(36).slice(2, 10)}@example.com` },
            { token: null },
          );
          ctx.status(unknown, 202);
          ctx.envelope(unknown);
          ctx.eq(unknown.body.data, null, "data is null");
          ctx.eq(
            unknown.body.message,
            "If an account exists for that email, a reset link has been sent.",
            "message",
          );
          await noEmail(since, "unknown address");
        },
      );

      await ctx.t(
        "reset-password rejects a malformed payload without consuming the token",
        async () => {
          const short = await ctx.post(
            "/api/auth/reset-password",
            { token: "abc", password: "NewPass123!" },
            { token: null },
          );
          ctx.status(short, 400);
          ctx.error(short);
          ctx.fieldErrors(short, "token");

          const weak = await ctx.post(
            "/api/auth/reset-password",
            { token: "x".repeat(43), password: "short" },
            { token: null },
          );
          ctx.status(weak, 400);
          ctx.error(weak);
          ctx.fieldErrors(weak, "password");

          const unknown = await ctx.post(
            "/api/auth/reset-password",
            { token: "n".repeat(43), password: "NewPass123!" },
            { token: null },
          );
          ctx.status(unknown, 400);
          ctx.eq(unknown.body.message, "Invalid or expired reset token.", "unknown token message");
        },
      );

      await ctx.t("verify-email rejects a malformed payload", async () => {
        const short = await ctx.post("/api/auth/verify-email", { token: "abc" }, { token: null });
        ctx.status(short, 400);
        ctx.error(short);
        ctx.fieldErrors(short, "token");

        const unknown = await ctx.post(
          "/api/auth/verify-email",
          { token: "v".repeat(43) },
          { token: null },
        );
        ctx.status(unknown, 400);
        ctx.eq(
          unknown.body.message,
          "Invalid or expired verification token.",
          "unknown token message",
        );
      });

      // ---------------------------------------------------------- one account, both flows
      // `register` fires the verification email in the background, so mark the mailbox first.
      const beforeRegister = mark();
      const acct = await ctx.registerTmp("recovery");
      let verifyToken = null;
      let resetToken = null;

      await ctx.t(
        "register emails a verification link that is bound to the address and works once",
        async () => {
          const mail = await waitForNew(outbox, beforeRegister, /verify-email\?token=/);
          ctx.ok(
            mail.message.to.some((t) => t.includes(acct.email)),
            `delivered to ${mail.message.to.join()}`,
          );
          ctx.eq(mail.subject, "Verify your email address", "subject");
          ctx.ok(
            mail.body.includes(`${ctx.baseUrl}/verify-email?token=`),
            `link rooted at APP_URL: ${mail.body.slice(0, 200)}`,
          );
          verifyToken = mail.body.match(TOKEN_RE)[1];
          ctx.ok(
            /^[A-Za-z0-9_-]{43}$/.test(verifyToken),
            `43-char base64url token: ${verifyToken}`,
          );

          // A reset token and a verification token are different keys for different locks.
          const cross = await ctx.post(
            "/api/auth/reset-password",
            { token: verifyToken, password: "NewPass123!" },
            { token: null },
          );
          ctx.status(cross, 400, "verification token on /reset-password");
          ctx.eq(cross.body.message, "Invalid or expired reset token.", "cross-type message");

          const ok = await ctx.post(
            "/api/auth/verify-email",
            { token: verifyToken },
            { token: null },
          );
          ctx.status(ok, 200);
          ctx.envelope(ok);
          ctx.eq(ok.body.message, "Email verified.", "message");
          ctx.eq(ok.body.data, null, "data is null");

          const reuse = await ctx.post(
            "/api/auth/verify-email",
            { token: verifyToken },
            { token: null },
          );
          ctx.status(reuse, 400, "reused verification token");
          ctx.eq(reuse.body.message, "Invalid or expired verification token.", "reuse message");
        },
      );

      await ctx.t(
        "password reset: link changes the password, revokes every session, works once",
        async () => {
          // A live session, so the revocation is observable from the outside.
          const before = await ctx.post(
            "/api/auth/login",
            { email: acct.email, password: acct.password },
            { token: null },
          );
          ctx.status(before, 200, "login before reset");
          const staleBearer = before.body.accessToken;

          const at = mark();
          const forgot = await ctx.post(
            "/api/auth/forgot-password",
            { email: acct.email },
            { token: null },
          );
          ctx.status(forgot, 202);
          ctx.eq(
            forgot.body.message,
            "If an account exists for that email, a reset link has been sent.",
            "message",
          );

          const mail = await waitForNew(outbox, at, /reset-password\?token=/);
          ctx.ok(
            mail.message.to.some((t) => t.includes(acct.email)),
            `delivered to ${mail.message.to.join()}`,
          );
          ctx.eq(mail.subject, "Reset your password", "subject");
          ctx.ok(mail.body.includes("works once"), "copy states the link is single-use");
          resetToken = mail.body.match(TOKEN_RE)[1];
          ctx.ok(/^[A-Za-z0-9_-]{43}$/.test(resetToken), `43-char base64url token: ${resetToken}`);

          // The reset token must not open the verification endpoint either.
          const cross = await ctx.post(
            "/api/auth/verify-email",
            { token: resetToken },
            { token: null },
          );
          ctx.status(cross, 400, "reset token on /verify-email");
          ctx.eq(
            cross.body.message,
            "Invalid or expired verification token.",
            "cross-type message",
          );

          const newPassword = `Reset-${Math.random().toString(36).slice(2, 10)}!`;
          const reset = await ctx.post(
            "/api/auth/reset-password",
            { token: resetToken, password: newPassword },
            { token: null },
          );
          ctx.status(reset, 200);
          ctx.envelope(reset);
          ctx.eq(reset.body.data, null, "data is null");
          ctx.ok(
            typeof reset.body.message === "string" && reset.body.message.length > 0,
            "message present",
          );

          // Every session of the account dies with the old password.
          const dead = await ctx.get("/api/sessions/me", { token: staleBearer });
          ctx.status(dead, 401, "pre-reset bearer after reset");
          ctx.error(dead);

          const oldPw = await ctx.post(
            "/api/auth/login",
            { email: acct.email, password: acct.password },
            { token: null },
          );
          ctx.status(oldPw, 401, "old password after reset");
          ctx.error(oldPw);

          const newPw = await ctx.post(
            "/api/auth/login",
            { email: acct.email, password: newPassword },
            { token: null },
          );
          ctx.status(newPw, 200, "new password after reset");
          const liveBearer = newPw.body.accessToken;
          const alive = await ctx.get("/api/sessions/me", { token: liveBearer });
          ctx.status(alive, 200, "new password opens a working session");

          // Single use: the very same link stops working the moment it has been claimed.
          const reuse = await ctx.post(
            "/api/auth/reset-password",
            { token: resetToken, password: `Another-${Math.random().toString(36).slice(2, 8)}!` },
            { token: null },
          );
          ctx.status(reuse, 400, "reused reset token");
          ctx.eq(reuse.body.message, "Invalid or expired reset token.", "reuse message");

          // A second request issues a fresh link and invalidates nothing already claimed.
          const beforeAgain = mark();
          const again = await ctx.post(
            "/api/auth/forgot-password",
            { email: acct.email },
            { token: null },
          );
          ctx.status(again, 202, "second forgot-password");
          const mail2 = await waitForNew(outbox, beforeAgain, /reset-password\?token=/);
          const secondToken = mail2.body.match(TOKEN_RE)[1];
          ctx.ok(secondToken !== resetToken, "a new link is issued");
          resetToken = secondToken;

          // The session opened with the first reset is untouched by a mere second request…
          const surviving = await ctx.get("/api/sessions/me", { token: liveBearer });
          ctx.status(surviving, 200, "session survives a second forgot-password");

          // …and the fresh link is still good for exactly one use.
          const reuse2 = await ctx.post(
            "/api/auth/reset-password",
            { token: resetToken, password: `Third-${Math.random().toString(36).slice(2, 8)}!` },
            { token: null },
          );
          ctx.status(reuse2, 200, "second link is usable");
          const dead2 = await ctx.get("/api/sessions/me", { token: liveBearer });
          ctx.status(dead2, 401, "bearer after the second reset");
        },
      );

      await ctx.t("recovery flows leave an audit trail", async () => {
        await ctx.loginAs("admin");
        const q = `userId=${ctx.vars.tmpUserId}`;
        ctx.eq(
          await auditCount(ctx, ctx.tokens.admin, `${q}&action=EMAIL_VERIFIED`),
          1,
          "EMAIL_VERIFIED",
        );
        ctx.eq(
          await auditCount(ctx, ctx.tokens.admin, `${q}&action=PASSWORD_RESET_REQUESTED`, 2),
          2,
          "PASSWORD_RESET_REQUESTED",
        );
        ctx.eq(
          await auditCount(ctx, ctx.tokens.admin, `${q}&action=PASSWORD_RESET`, 2),
          2,
          "PASSWORD_RESET",
        );
        ctx.eq(await auditCount(ctx, ctx.tokens.admin, `${q}&action=REGISTER`), 1, "REGISTER");
      });

      // ---------------------------------------------------------- resend + throttle
      const beforeResendRegister = mark();
      const resendAcct = await ctx.registerTmp("recovery-resend");

      await ctx.t("resend-verification sends at most 3 emails per address per hour", async () => {
        // Flush the email that `register` already fired, so it is not mistaken for a resend.
        await waitForNew(outbox, beforeResendRegister, /verify-email\?token=/);
        const tokens = [];
        for (let i = 0; i < 3; i += 1) {
          const at = mark();
          const res = await ctx.post(
            "/api/auth/resend-verification",
            { email: resendAcct.email },
            { token: null },
          );
          ctx.status(res, 202, `resend #${i + 1}`);
          ctx.eq(res.body.data, null, "data is null");
          const mail = await waitForNew(outbox, at, /verify-email\?token=/);
          tokens.push(mail.body.match(TOKEN_RE)[1]);
        }
        // Only the newest link survives: each resend invalidates the previous one.
        const stale = await ctx.post(
          "/api/auth/verify-email",
          { token: tokens[0] },
          { token: null },
        );
        ctx.status(stale, 400, "superseded verification token");
        ctx.eq(stale.body.message, "Invalid or expired verification token.", "superseded message");

        // Fourth request inside the hour: still 202, but the mailbox stays quiet.
        const since = mark();
        const throttled = await ctx.post(
          "/api/auth/resend-verification",
          { email: resendAcct.email },
          { token: null },
        );
        ctx.status(throttled, 202, "throttled resend still answers 202");
        await noEmail(since, "per-address mail throttle");

        const ok = await ctx.post("/api/auth/verify-email", { token: tokens[2] }, { token: null });
        ctx.status(ok, 200, "newest token still verifies");
      });

      await ctx.t(
        "resend-verification for a verified address answers 202 and sends nothing",
        async () => {
          const since = mark();
          const res = await ctx.post(
            "/api/auth/resend-verification",
            { email: resendAcct.email },
            { token: null },
          );
          ctx.status(res, 202);
          ctx.eq(
            res.body.message,
            "If the account exists and is not verified, a new link has been sent.",
            "message",
          );
          await noEmail(since, "already verified");

          const ghost = await ctx.post(
            "/api/auth/resend-verification",
            { email: `ghost-${Math.random().toString(36).slice(2, 10)}@example.com` },
            { token: null },
          );
          ctx.status(ghost, 202, "unknown address");
          ctx.eq(
            ghost.body.message,
            "If the account exists and is not verified, a new link has been sent.",
            "message identical to the known-address case",
          );
        },
      );

      // ---------------------------------------------------------- blocked accounts
      const beforeBlockedRegister = mark();
      const blocked = await ctx.registerTmp("recovery-blocked");

      await ctx.t("blocked accounts receive no recovery email but keep the same 202", async () => {
        // Flush the verification email `register` fired before the account was suspended.
        await waitForNew(outbox, beforeBlockedRegister, /verify-email\?token=/);
        await ctx.loginAs("admin");
        const block = await ctx.patch(`/api/users/${blocked.id}/block`, {
          isBlocked: true,
          reason: "contract test",
        });
        ctx.status(block, 200);
        ctx.eq(block.body.data.isBlocked, true, "isBlocked");

        const since = mark();
        const forgot = await ctx.post(
          "/api/auth/forgot-password",
          { email: blocked.email },
          { token: null },
        );
        ctx.status(forgot, 202, "forgot-password for blocked account");
        ctx.eq(
          forgot.body.message,
          "If an account exists for that email, a reset link has been sent.",
          "message identical to the live-account case",
        );

        const resend = await ctx.post(
          "/api/auth/resend-verification",
          { email: blocked.email },
          { token: null },
        );
        ctx.status(resend, 202, "resend-verification for blocked account");
        await noEmail(since, "blocked account");
      });

      // ---------------------------------------------------------- invariants
      await ctx.t("demo accounts are untouched by the recovery group", async () => {
        const admin = await ctx.post(
          "/api/auth/login",
          { email: "admin@example.com", password: "password123" },
          { token: null },
        );
        ctx.status(admin, 200, "admin@example.com still signs in");
        const user = await ctx.post(
          "/api/auth/login",
          { email: "ana@example.com", password: "password123" },
          { token: null },
        );
        ctx.status(user, 200, "ana@example.com still signs in");
      });
    } finally {
      if (close) await close();
    }
  },
};
