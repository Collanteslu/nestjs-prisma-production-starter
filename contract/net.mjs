// Harness utilities: minimal SMTP sink (captures emails black-box), TOTP generator
// (for MFA flows) and rate-limit bucket isolation between scenario groups.
import net from "node:net";
import crypto from "node:crypto";

// ---------------------------------------------------------------- SMTP sink
export function startSmtpSink(port = 2525) {
  const messages = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    let current = null;
    socket.write("220 contract-sink ESMTP ready\r\n");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const idx = buffer.indexOf("\r\n.\r\n");
          if (idx === -1) return;
          current.data = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 5);
          inData = false;
          messages.push(current);
          current = null;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const idx = buffer.indexOf("\r\n");
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) socket.write("250-contract-sink\r\n250 8BITMIME\r\n");
        else if (upper.startsWith("HELO")) socket.write("250 contract-sink\r\n");
        else if (upper.startsWith("MAIL FROM")) {
          current = { from: line.slice(line.indexOf(":") + 1).trim(), to: [], data: "" };
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          if (current) current.to.push(line.slice(line.indexOf(":") + 1).trim());
          socket.write("250 OK\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper.startsWith("RSET")) {
          current = null;
          socket.write("250 OK\r\n");
        } else if (upper.startsWith("NOOP")) socket.write("250 OK\r\n");
        else if (upper.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
          socket.end();
        } else socket.write("250 OK\r\n");
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return {
    port,
    messages,
    url: `smtp://127.0.0.1:${port}`,
    /** Wait until an email whose raw content matches `re` arrives. */
    async waitFor(re, timeoutMs = 8000) {
      const start = Date.now();
      for (;;) {
        const hit = messages.find((m) => re.test(m.data));
        if (hit) return hit;
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `timeout waiting for email matching ${re}; captured ${messages.length} message(s)`,
          );
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------- TOTP (RFC 6238)
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input) {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32, { step = 30, digits = 6, offsetSeconds = 0 } = {}) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor((Math.floor(Date.now() / 1000) + offsetSeconds) / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const idx = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[idx] & 0x7f) << 24) |
    ((hmac[idx + 1] & 0xff) << 16) |
    ((hmac[idx + 2] & 0xff) << 8) |
    (hmac[idx + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Brute-force a 6-digit code for the current window ±1 (mirrors server drift allowance). */
export function totpCandidates(secretBase32) {
  return [-30, 0, 30].map((off) => totp(secretBase32, { offsetSeconds: off }));
}

// ------------------------------------------------- rate limit isolation (same schema)
export async function resetRateLimitBuckets(dbPath) {
  if (!dbPath) return;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("DELETE FROM RateLimitBucket");
  } finally {
    db.close();
  }
}
