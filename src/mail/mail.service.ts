import { Inject, Injectable, Logger } from "@nestjs/common";
// Types only: nodemailer itself is loaded lazily, the first time an SMTP message is sent, so
// AUTH_MODE=basic/none (or MAIL_TRANSPORT other than smtp) never load it at runtime
import type { Transporter } from "nodemailer";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transport configuration for the configured environment. In production TLS is
 * MANDATORY: `smtps://` delivers over implicit TLS, and plain `smtp://` (the usual
 * submission port 587) is forced to upgrade with STARTTLS — nodemailer then refuses to
 * send in plaintext (`requireTLS` takes precedence over `ignoreTLS`/
 * `opportunisticTLS`), and the env validation rejects URLs that disable certificate
 * verification (`ignoreTLS=true`, `rejectUnauthorized=false`). Outside production no
 * option is set so local/dev plaintext sinks (the contract harness on :2525) keep working.
 *
 * Options travel in the FIRST argument (`{ url, requireTLS }`): nodemailer 10's typings
 * type the second argument as mail defaults, not transport options.
 */
export function smtpTransportConfig(env: Env): { url: string; requireTLS?: boolean } {
  // SMTP_URL is guaranteed non-empty by env validation when MAIL_TRANSPORT=smtp
  const url = env.SMTP_URL as string;
  return env.NODE_ENV === "production" ? { url, requireTLS: true } : { url };
}

/**
 * Pluggable outgoing mail. The transport is chosen with MAIL_TRANSPORT:
 * - `none`   : nothing is sent (default in production until SMTP is configured)
 * - `log`    : development mailbox — the message is written to stdout (it contains the
 *              token). Env validation REJECTS this transport in production, and the
 *              runtime check below refuses the body there even if validation is bypassed,
 *              so a live token can never reach a shipped log stream.
 * - `smtp`   : delivered through SMTP_URL with nodemailer
 * - `memory` : kept in `outbox` (tests only)
 *
 * Logging policy (OWASP Logging Cheat Sheet): no logger call in this class ever records
 * the message body or the tokens it embeds — only subject, recipient class and errors.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private smtp: Transporter | undefined;

  /** Messages captured by the `memory` transport */
  readonly outbox: MailMessage[] = [];

  constructor(@Inject(APP_ENV) private readonly env: Env) {}

  /** True when messages actually reach people (the flows that depend on email are usable) */
  get mailDelivers(): boolean {
    return this.env.MAIL_TRANSPORT === "smtp" || this.env.MAIL_TRANSPORT === "memory";
  }

  /**
   * Sends a message. Never throws: a mail failure must not turn a request into a 500 nor reveal
   * whether an address exists, so errors are logged and reported through the return value.
   */
  async sendMail(message: MailMessage): Promise<boolean> {
    try {
      switch (this.env.MAIL_TRANSPORT) {
        case "none":
          this.logger.warn(`Mail transport disabled: message not sent (${message.subject})`);
          return false;
        case "log":
          // Defense in depth behind the env validation: never write a message body in production
          if (this.env.NODE_ENV === "production") {
            this.logger.warn(
              `MAIL_TRANSPORT=log refused in production; message not sent (${message.subject})`,
            );
            return false;
          }
          this.logger.log(
            `📧 DEV MAILBOX to=${message.to} subject=${message.subject}\n${message.text}`,
          );
          return true;
        case "memory":
          this.outbox.push(message);
          return true;
        case "smtp":
          this.smtp ??= (await import("nodemailer")).default.createTransport(
            smtpTransportConfig(this.env),
          );
          await this.smtp.sendMail({ from: this.env.MAIL_FROM, ...message });
          return true;
      }
    } catch (error) {
      // Subject only: the body (which embeds single-use tokens) must never enter the logs
      this.logger.error(`Failed to send mail (${message.subject}): ${String(error)}`);
      return false;
    }
  }
}
