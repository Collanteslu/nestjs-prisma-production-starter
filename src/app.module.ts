import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor } from "nestjs-zod";
import type { Env } from "./config/env";
import { featuresOf } from "./config/env";
import { ConfigProviderModule } from "./config/config.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ContractValidationPipe } from "./common/pipes/contract-validation.pipe";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { AuthPrefixMiddleware } from "./common/middleware/auth-prefix.middleware";
import { DatabaseModule } from "./database/database.module";
import { SeedService } from "./database/seed.service";
import { HealthController } from "./health/health.controller";
import { SystemController } from "./system/system.controller";
import { AuditLogsModule } from "./audit/audit-logs.module";
import { AuditModule } from "./audit/audit.module";
import { MailModule } from "./mail/mail.module";
import { RateLimitGuard } from "./rate-limit/rate-limit.guard";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { AuthModule } from "./auth/auth.module";
import { CleanupService } from "./jobs/cleanup.service";
import { MfaModule } from "./mfa/mfa.module";
import { MfaRoutesModule } from "./mfa/mfa.routes.module";
import { RecoveryModule } from "./recovery/recovery.module";
import { SessionsModule } from "./sessions/sessions.module";
import { TasksModule } from "./tasks/tasks.module";
import { UsersModule } from "./users/users.module";

/**
 * Application root. Configuration enters through `AppModule.forRoot(env)` — no module
 * reads process.env on import (testable factory, per plan). APP_ENV/APP_FEATURES are
 * published by the global ConfigProviderModule.
 *
 * Global providers follow the reference's pipeline order:
 * guards (JWT auth → rate limit) → validation pipe → serializer →
 * envelope interceptor → exception filter.
 *
 * Interceptor registration order matters: TransformInterceptor (envelope) must be
 * OUTSIDE ZodSerializerInterceptor so serialized data is wrapped afterwards.
 */
@Module({})
export class AppModule implements NestModule {
  /**
   * Port of the reference's prefix auth mounting (`app.use(prefix, authMiddleware)` +
   * `app.use(prefix + "/*", authMiddleware)` for the four protected prefixes). It makes
   * authentication apply to each prefix and all its sub-paths, so an unauthenticated
   * request to an unmounted sub-path answers 401 rather than leaking a 404. The middleware
   * is a no-op with AUTH_MODE=none, and there are no `@Public()` routes under these
   * prefixes, so it can demand a token unconditionally.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthPrefixMiddleware).forRoutes(
      // Each protected prefix and all its sub-paths. Nest registers class middleware per
      // matched route (not via Express `use()`), so the sub-path wildcard is explicit.
      // In Express 5 / path-to-regexp v8 the wildcard is `{*splat}`.
      ...["api/sessions", "api/users", "api/tasks", "api/audit-logs"].flatMap((prefix) => [
        { path: prefix, method: RequestMethod.ALL },
        { path: `${prefix}/{*splat}`, method: RequestMethod.ALL },
      ]),
    );
  }

  static forRoot(env: Env): DynamicModule {
    const features = featuresOf(env);
    return {
      module: AppModule,
      imports: [
        ConfigProviderModule.forEnv(env),
        DatabaseModule,
        RateLimitModule,
        AuditModule,
        MailModule,
        MfaModule, // TOTP/recovery-code services: global, always present (login may need them)
        TasksModule, // public/ownerless with AUTH_MODE=none, bearer-protected otherwise
        // The auth stack (and its routes) exists exactly when the reference mounts it
        ...(features.auth ? [SessionsModule, AuthModule, UsersModule, AuditLogsModule] : []),
        // Account security (recovery emails + MFA management) is AUTH_MODE=full only
        ...(features.accountSecurity ? [RecoveryModule, MfaRoutesModule] : []),
      ],
      controllers: [HealthController, SystemController],
      providers: [
        SeedService,
        CleanupService,
        // JwtAuthGuard as a regular provider so AuthPrefixMiddleware can inject the SAME
        // instance the APP_GUARD token reuses (useExisting instead of useClass)
        JwtAuthGuard,
        { provide: APP_GUARD, useExisting: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_PIPE, useClass: ContractValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
