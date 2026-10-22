import { Global, Module } from "@nestjs/common";
import { LoginLockoutService } from "./login-lockout.service";
import { RateLimitGuard } from "./rate-limit.guard";
import { RateLimitService } from "./rate-limit.service";

/**
 * Global rate-limiting infrastructure: DB-backed fixed windows (RateLimitService), the
 * global metadata-driven guard and the per-account login lockout.
 */
@Global()
@Module({
  providers: [RateLimitService, LoginLockoutService, RateLimitGuard],
  exports: [RateLimitService, LoginLockoutService, RateLimitGuard],
})
export class RateLimitModule {}
