import { Module } from "@nestjs/common";
import { TokensService } from "../auth/tokens.service";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

/**
 * Session lifecycle: token pair issuance, atomic refresh rotation with reuse detection,
 * revocation, and the `/api/sessions` routes. Imported by AppModule only when
 * `features.auth`, which makes the routes conditional exactly like the reference.
 */
@Module({
  controllers: [SessionsController],
  providers: [TokensService, SessionsService],
  exports: [TokensService, SessionsService],
})
export class SessionsModule {}
