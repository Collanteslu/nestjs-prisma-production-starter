import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUserPayload } from "../auth/auth.types";

/**
 * Restricts a route to administrators (port of requireAdmin). Must run after the global
 * JwtAuthGuard, which attaches the (database-sourced) role to the request.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUserPayload }>();
    if (request.user?.role !== "admin") {
      throw new ForbiddenException("Forbidden: This action requires administrator privileges.");
    }
    return true;
  }
}
