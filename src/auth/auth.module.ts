import { Module } from "@nestjs/common";
import { SessionsModule } from "../sessions/sessions.module";
import { AuthController } from "./auth.controller";

/**
 * `/api/auth` routes (register, login, refresh with rotation, logout). Imported by
 * AppModule only when `features.auth`, so the routes exist exactly as in the Hono starter
 * (they are also `@Public()` — the global guard skips them and rate limits apply instead).
 */
@Module({
  imports: [SessionsModule],
  controllers: [AuthController],
})
export class AuthModule {}
