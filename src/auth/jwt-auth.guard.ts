import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Inject, Injectable, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import type { Env, Features } from "../config/env";
import { APP_ENV, APP_FEATURES } from "../config/tokens";
import { PrismaService } from "../database/prisma.service";
import { IS_PUBLIC_KEY } from "../common/decorators/public.decorator";
import type { AuthUserPayload, JwtPayload } from "../auth/auth.types";

/**
 * Global authentication guard (port of the Hono starter's authMiddleware): runs `authenticate`
 * on every matched route. The role attached to the request comes from the database, so
 * role changes apply immediately. `@Public()` routes and AUTH_MODE=none skip the guard
 * entirely, and requests already authenticated by AuthPrefixMiddleware are not re-verified.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt = new JwtService();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic || !this.features.auth) return true;

    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUserPayload }>();
    // AuthPrefixMiddleware already authenticated this request (protected prefixes)
    if (request.user) return true;

    await this.authenticate(request);
    return true;
  }

  /**
   * Full authentication of a request (port of the Hono starter's authMiddleware core).
   * 1. Cryptographic validation: verifies the JWT signature (HS256, JWT_SECRET).
   * 2. Real-time block checking: `user.isBlocked` is re-read from the database.
   * 3. Stateful session validation: the `sessionId` must exist and be active.
   * Attaches `request.user` on success; throws 401/403 otherwise. Shared with
   * AuthPrefixMiddleware so the verification logic exists exactly once.
   */
  async authenticate(request: Request & { user?: AuthUserPayload }): Promise<AuthUserPayload> {
    const authHeader = request.headers.authorization;

    // Verify Bearer schema structure
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException(
        "Unauthorized: Missing or malformed Bearer Token in Authorization header.",
      );
    }

    const token = authHeader.slice("Bearer ".length).trim();

    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token, {
        secret: this.env.JWT_SECRET,
        algorithms: ["HS256"],
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired authentication token.");
    }

    // Every access token must be bound to a session so it can be revoked in real time
    if (!payload.userId || !payload.sessionId) {
      throw new UnauthorizedException("Invalid or expired authentication token.");
    }

    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, role: true, isBlocked: true, blockedReason: true, deletedAt: true },
      }),
      this.prisma.session.findUnique({
        where: { id: payload.sessionId },
        select: { userId: true, isActive: true, expiresAt: true },
      }),
    ]);

    // 1. Verify user existence and real-time suspension state
    if (!user || user.deletedAt) {
      throw new UnauthorizedException(
        "Unauthorized: Account associated with this token no longer exists.",
      );
    }

    if (user.isBlocked) {
      throw new ForbiddenException(
        `Access denied: Account has been suspended. Reason: ${user.blockedReason || "Policy violation"}.`,
      );
    }

    // 2. Stateful session check: the session must be active and belong to the user
    if (!session?.isActive || session.userId !== user.id || session.expiresAt < new Date()) {
      throw new UnauthorizedException("Session has been revoked or expired. Please sign in again.");
    }

    const identity: AuthUserPayload = {
      userId: payload.userId,
      sessionId: payload.sessionId,
      email: payload.email,
      role: user.role,
    };
    request.user = identity;
    return identity;
  }
}
