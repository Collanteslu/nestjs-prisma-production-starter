import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import type { IssuedTokens, JwtPayload, RefreshTokenPayload, TokenSubject } from "./auth.types";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 15;
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Signs and verifies the two token families of the Hono starter:
 * - Access token  (JWT_SECRET, 15 min): userId, sessionId, email, role.
 * - Refresh token (JWT_REFRESH_SECRET, absolute session expiry): userId, sessionId, jti.
 */
@Injectable()
export class TokensService {
  private readonly jwt = new JwtService();

  constructor(@Inject(APP_ENV) private readonly env: Env) {}

  /**
   * Signs an access + refresh pair. The session is absolute: its lifetime is fixed at login,
   * so a rotated refresh token never outlives `sessionExpiresAt` (defaults to a full TTL for
   * new sessions).
   */
  signTokenPair(
    user: TokenSubject,
    sessionId: string,
    sessionExpiresAt?: Date,
  ): { accessToken: string; refreshToken: string; refreshExpiresAt: Date } {
    const nowSec = Math.floor(Date.now() / 1000);
    const refreshExp = sessionExpiresAt
      ? Math.floor(sessionExpiresAt.getTime() / 1000)
      : nowSec + SESSION_TTL_SECONDS;

    const accessToken = this.jwt.sign(
      {
        userId: user.id,
        sessionId,
        email: user.email,
        role: user.role,
      },
      {
        secret: this.env.JWT_SECRET,
        algorithm: "HS256",
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    );

    const refreshToken = this.jwt.sign(
      {
        userId: user.id,
        sessionId,
        jti: randomUUID(),
      },
      {
        secret: this.env.JWT_REFRESH_SECRET,
        algorithm: "HS256",
        expiresIn: refreshExp - nowSec,
      },
    );

    return { accessToken, refreshToken, refreshExpiresAt: new Date(refreshExp * 1000) };
  }

  /** Cryptographically verifies an access token. Throws on any failure. */
  verifyAccessToken(token: string): JwtPayload {
    return this.jwt.verify<JwtPayload>(token, {
      secret: this.env.JWT_SECRET,
      algorithms: ["HS256"],
    });
  }

  /** Cryptographically verifies a refresh token. Throws on any failure. */
  verifyRefreshToken(token: string): RefreshTokenPayload {
    return this.jwt.verify<RefreshTokenPayload>(token, {
      secret: this.env.JWT_REFRESH_SECRET,
      algorithms: ["HS256"],
    });
  }

  /** Issues the full login pair (tokens + expiresIn metadata) */
  issueTokens(user: TokenSubject, sessionId: string): IssuedTokens {
    const { accessToken, refreshToken } = this.signTokenPair(user, sessionId);
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, sessionId };
  }
}
