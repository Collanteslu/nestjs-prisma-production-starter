import { Module } from "@nestjs/common";
import { TokensService } from "../auth/tokens.service";
import { SessionsService } from "./sessions.service";

/**
 * Session lifecycle infrastructure (token pair issuance, atomic refresh rotation with
 * reuse detection, revocation). The `/api/sessions` controller joins this module in D3,
 * which is what makes those routes conditional on `features.auth`.
 */
@Module({
  providers: [TokensService, SessionsService],
  exports: [TokensService, SessionsService],
})
export class SessionsModule {}
