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
 * Pluggable outgoing mail. The transport is chosen with MAIL_TRANSPORT:
 * - `none`   : nothing is sent (default in production until SMTP is configured)
 * - `log`    : the message is printed to the log (development convenience; it contains the token)
 * - `smtp`   : delivered through SMTP_URL with nodemailer
 * - `memory` : kept in `outbox` (tests only)
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
          this.logger.log(
            `📧 Mail to=${message.to} subject=${message.subject}\n${message.text}`,
          );
          return true;
        case "memory":
          this.outbox.push(message);
          return true;
        case "smtp":
          this.smtp ??= (await import("nodemailer")).default.createTransport(
            this.env.SMTP_URL,
          );
          await this.smtp.sendMail({ from: this.env.MAIL_FROM, ...message });
          return true;
      }
    } catch (error) {
      this.logger.error(`Failed to send mail (${message.subject}): ${String(error)}`);
      return false;
    }
  }
}
