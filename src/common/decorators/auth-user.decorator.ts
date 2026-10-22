import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUserPayload } from "../../auth/auth.types";

export type RequestWithUser = Request & { user?: AuthUserPayload };

/** Injects the identity attached by the global JwtAuthGuard. */
export const AuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserPayload =>
    ctx.switchToHttp().getRequest<RequestWithUser>().user as AuthUserPayload,
);
