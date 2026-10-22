import { Global, Module } from "@nestjs/common";
import { LoginLockoutService } from "./login-lockout.service";
import { PasswordConfirmLockoutService } from "./password-confirm-lockout.service";
import { RateLimitGuard } from "./rate-limit.guard";
import { RateLimitService } from "./rate-limit.service";

/**
 * Global rate-limiting infrastructure: DB-backed fixed windows (RateLimitService), the
 * global metadata-driven guard, the per-account login lockout and the shared
 * password-confirm lockout (PUT /api/users/:id and MFA enrolment).
 */
@Global()
@Module({
  providers: [RateLimitService, LoginLockoutService, PasswordConfirmLockoutService, RateLimitGuard],
  exports: [RateLimitService, LoginLockoutService, PasswordConfirmLockoutService, RateLimitGuard],
})
export class RateLimitModule {}
