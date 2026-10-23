import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { AuthTokensService } from "./auth-tokens.service";
import { MailService } from "./mail.service";

interface Recipient {
  id: string;
  name: string;
  email: string;
}

const minutes = (n: number) => n * 60_000;

/**
 * Emails sent by the account flows. Sending is fire-and-forget on purpose at the call
 * sites (or handed to the durable outbox): the HTTP response must not depend on (or
 * reveal through its latency) whether an address exists. Each method reports whether the
 * underlying transport accepted the message, so the outbox can retry failures.
 */
@Injectable()
export class AccountMailService {
  constructor(
    private readonly mailer: MailService,
    private readonly authTokens: AuthTokensService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async sendVerificationEmail(user: Recipient): Promise<boolean> {
    const token = await this.authTokens.createAuthToken(
      user,
      "email_verify",
      this.env.EMAIL_VERIFY_TTL_HOURS * 60 * minutes(1),
    );
    return this.mailer.sendMail({
      to: user.email,
      subject: "Verify your email address",
      text: `Hi ${user.name},\n\nConfirm your email address by opening:\n${this.env.APP_URL}/verify-email?token=${token}\n\nThe link is valid for ${this.env.EMAIL_VERIFY_TTL_HOURS} hours. If you did not create this account, ignore this message.`,
    });
  }

  /**
   * Tells the address the account had BEFORE a change that the email moved. It carries no token,
   * so an abandoned or bounced mailbox cannot lock anyone out. Without it, an attacker who
   * changes the email keeps the real owner completely in the dark.
   */
  async sendEmailChangedNotice(recipient: { name: string; email: string }): Promise<boolean> {
    return this.mailer.sendMail({
      to: recipient.email,
      subject: "Your account email was changed",
      text: `Hi ${recipient.name},\n\nThe email address on your account was changed. If you did not do it, sign in and choose a new password right away, or ask support to lock the account.`,
    });
  }

  async sendPasswordResetEmail(user: Recipient): Promise<boolean> {
    const token = await this.authTokens.createAuthToken(
      user,
      "password_reset",
      minutes(this.env.PASSWORD_RESET_TTL_MINUTES),
    );
    return this.mailer.sendMail({
      to: user.email,
      subject: "Reset your password",
      text: `Hi ${user.name},\n\nSomeone asked to reset your password. To choose a new one, open:\n${this.env.APP_URL}/reset-password?token=${token}\n\nThe link is valid for ${this.env.PASSWORD_RESET_TTL_MINUTES} minutes and works once. If it was not you, ignore this message: your password stays the same.`,
    });
  }
}
