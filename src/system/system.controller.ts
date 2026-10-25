import { Controller, Get, Inject } from "@nestjs/common";
import { ApiExcludeController, ApiOperation } from "@nestjs/swagger";
import { docsEnabled } from "../config/env";
import type { Env, Features } from "../config/env";
import { APP_ENV, APP_FEATURES } from "../config/tokens";
import { Public } from "../common/decorators/public.decorator";
import { NoEnvelope } from "../common/decorators/envelope.decorator";
import { API_VERSION } from "../instrumentation/request-context";

/**
 * Root welcome and overview endpoint: lists only the endpoints mounted for the
 * current AUTH_MODE (same shape and wording as the Hono starter).
 */
@ApiExcludeController()
@Controller()
export class SystemController {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  @Get()
  @Public()
  @NoEnvelope()
  @ApiOperation({ summary: "Overview of the mounted endpoints" })
  index(): Record<string, unknown> {
    const { auth, accountSecurity } = this.features;
    // /docs only exists when the documentation is enabled (off by default in production):
    // do not advertise a link that answers 404
    const docs = docsEnabled(this.env);
    return {
      status: "online",
      name: "Production REST API Template with NestJS, Prisma 7, SQLite & Stateful Sessions",
      version: API_VERSION,
      authMode: this.env.AUTH_MODE,
      ...(docs && { documentationUrl: "/docs" }),
      endpoints: {
        healthcheck: "/healthz",
        ...(docs && { documentation: "/docs" }),
        ...(auth && {
          auth: {
            register: "POST /api/auth/register",
            login: "POST /api/auth/login",
            refresh: "POST /api/auth/refresh",
            logout: "POST /api/auth/logout",
            ...(accountSecurity && {
              forgotPassword: "POST /api/auth/forgot-password",
              resetPassword: "POST /api/auth/reset-password",
              verifyEmail: "POST /api/auth/verify-email",
              resendVerification: "POST /api/auth/resend-verification",
            }),
          },
        }),
        ...(accountSecurity && {
          mfa: {
            setup: "POST /api/auth/mfa/setup",
            enable: "POST /api/auth/mfa/enable",
            disable: "POST /api/auth/mfa/disable",
          },
        }),
        ...(auth && {
          sessions: {
            mySessions: "GET /api/sessions/me",
            revokeSession: "DELETE /api/sessions/:sessionId",
            revokeAll: "POST /api/sessions/revoke-all",
          },
          users: {
            crud: "GET, POST, PUT, DELETE /api/users",
            blockUser: "PATCH /api/users/:id/block",
            revokeAllUserSessions: "POST /api/users/:id/revoke-sessions",
            ...(accountSecurity && { resetUserMfa: "DELETE /api/users/:id/mfa" }),
          },
        }),
        tasks: "GET, POST, PUT, DELETE /api/tasks",
        restoreTask: "POST /api/tasks/:id/restore",
        ...(auth && { auditLogs: "GET /api/audit-logs" }),
      },
    };
  }
}
