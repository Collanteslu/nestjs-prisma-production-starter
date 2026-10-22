import { Module } from "@nestjs/common";
import { SessionsModule } from "../sessions/sessions.module";
import { UsersController } from "./users.controller";

/**
 * `/api/users` routes (admin CRUD, blocking, role changes, session revocation).
 * Imported by AppModule only when `features.auth`, keeping the routes exactly as
 * conditional as the reference (absent with AUTH_MODE=none).
 */
@Module({
  imports: [SessionsModule],
  controllers: [UsersController],
})
export class UsersModule {}
