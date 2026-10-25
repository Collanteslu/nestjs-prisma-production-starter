import { Module } from "@nestjs/common";
import { SessionsModule } from "../sessions/sessions.module";
import { MfaController } from "./mfa.controller";
import { MfaResetController } from "./mfa-reset.controller";

/**
 * `/api/auth/mfa/*` and `DELETE /api/users/:id/mfa` routes. Imported by AppModule only
 * when `features.accountSecurity` (AUTH_MODE=full), which keeps the routes exactly as
 * conditional as the Hono starter. The MFA *services* live in the global MfaModule.
 */
@Module({
  imports: [SessionsModule],
  controllers: [MfaController, MfaResetController],
})
export class MfaRoutesModule {}
