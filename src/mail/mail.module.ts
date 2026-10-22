import { Global, Module } from "@nestjs/common";
import { AccountMailService } from "./account-mail.service";
import { AuthTokensService } from "./auth-tokens.service";
import { MailService } from "./mail.service";

/**
 * Global outgoing-mail infrastructure: pluggable transports (none/log/smtp/memory),
 * the emailed single-use tokens and the account-flow templates.
 */
@Global()
@Module({
  providers: [MailService, AuthTokensService, AccountMailService],
  exports: [MailService, AuthTokensService, AccountMailService],
})
export class MailModule {}
