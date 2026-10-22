import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { AuthUserPayload } from "../../auth/auth.types";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import type { Features } from "../../config/env";
import { APP_FEATURES } from "../../config/tokens";

/**
 * Port of the reference's route-prefix auth mounting:
 *   app.use("/api/users", authMiddleware);
 *   app.use("/api/users/*", authMiddleware);
 * (the four protected prefixes are /api/sessions, /api/users, /api/tasks, /api/audit-logs).
 *
 * In the reference the middleware guards the prefix AND every sub-path, so a request to a
 * sub-path that no route matches still runs authentication and answers 401 without a token
 * (404 is only reached once authenticated). A global Nest guard only runs on *matched*
 * routes, so without this middleware an unauthenticated probe of an unmounted sub-path would
 * leak 404 and diverge from the reference. This keeps the same observable behaviour:
 * authentication is enforced for the protected prefixes and all their sub-paths.
 *
 * `authenticate` is the same shared logic the global JwtAuthGuard uses, so the payload
 * attached here (`request.user`) is reused by the guard and the token is verified once.
 * AUTH_MODE=none has no protected prefixes, so the middleware is a no-op.
 */
@Injectable()
export class AuthPrefixMiddleware implements NestMiddleware {
  constructor(
    private readonly guard: JwtAuthGuard,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  async use(
    req: Request & { user?: AuthUserPayload },
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.features.auth) {
      next();
      return;
    }
    // authenticate() throws 401/403 itself; an already-attached user is not re-verified
    await this.guard.authenticate(req);
    next();
  }
}
