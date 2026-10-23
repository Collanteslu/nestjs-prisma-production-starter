import { Global, Module } from "@nestjs/common";
import { AccountMailService } from "./account-mail.service";
import { AuthTokensService } from "./auth-tokens.service";
import { EmailOutboxService } from "./email-outbox.service";
import { MailService } from "./mail.service";

/**
 * Global outgoing-mail infrastructure: pluggable transports (none/log/smtp/memory),
 * the emailed single-use tokens, the account-flow templates and the durable outbox
 * worker that delivers them with bounded retries.
 */
@Global()
@Module({
  providers: [MailService, AuthTokensService, AccountMailService, EmailOutboxService],
  exports: [MailService, AuthTokensService, AccountMailService, EmailOutboxService],
})
export class MailModule {}
