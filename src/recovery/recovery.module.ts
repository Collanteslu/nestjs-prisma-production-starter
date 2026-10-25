import { Module } from "@nestjs/common";
import { SessionsModule } from "../sessions/sessions.module";
import { RecoveryController } from "./recovery.controller";

/**
 * `/api/auth/{forgot-password,reset-password,verify-email,resend-verification}` routes.
 * Imported by AppModule only when `features.accountSecurity` (AUTH_MODE=full), keeping
 * them exactly as conditional as the Hono starter.
 */
@Module({
  imports: [SessionsModule],
  controllers: [RecoveryController],
})
export class RecoveryModule {}
