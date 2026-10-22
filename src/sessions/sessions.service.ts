import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { PrismaService } from "../database/prisma.service";
import { hashToken } from "../common/utils/hash-token";
import { ACCESS_TOKEN_TTL_SECONDS, TokensService } from "../auth/tokens.service";
import type { IssuedTokens, RefreshTokenPayload, TokenSubject } from "../auth/auth.types";

export type RotationResult =
  | { status: "rotated"; tokens: IssuedTokens }
  | { status: "invalid_account" }
  | { status: "session_inactive" }
  | { status: "concurrent" }
  | { status: "reused" };

/**
 * Session lifecycle: issuing token pairs, atomic refresh token rotation with reuse
 * detection, and revocation. Refresh tokens are persisted only as SHA-256 hashes.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /**
   * Creates an active database session record and issues an Access + Refresh Token pair.
   */
  async createSessionAndTokens(
    user: TokenSubject,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<IssuedTokens> {
    const sessionId: string = randomUUID();
    const { accessToken, refreshToken, refreshExpiresAt } = this.tokens.signTokenPair(
      user,
      sessionId,
    );

    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          userAgent: userAgent || "Unknown Client",
          ipAddress: ipAddress || "unknown",
          isActive: true,
          expiresAt: refreshExpiresAt,
        },
      }),
      this.prisma.refreshToken.create({
        data: {
          tokenHash: hashToken(refreshToken),
          userId: user.id,
          sessionId,
          expiresAt: refreshExpiresAt,
        },
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      sessionId,
    };
  }

  /**
   * Exchanges a verified refresh token for a new pair (Token Rotation).
   *
   * - The token is claimed atomically (`usedAt IS NULL` guard), so it can only be rotated once.
   * - Re-presenting a token rotated within REFRESH_REUSE_GRACE_SECONDS is treated as a benign
   *   concurrent refresh (the other request already holds the new pair).
   * - Re-presenting it later (or an unknown token) is treated as theft: the session is revoked.
   */
  async rotateRefreshToken(
    refreshToken: string,
    payload: RefreshTokenPayload,
  ): Promise<RotationResult> {
    const sessionId = payload.sessionId;
    if (!payload.userId || !sessionId) return { status: "session_inactive" };

    const now = new Date();
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, email: true, role: true, isBlocked: true, deletedAt: true },
      }),
      this.prisma.session.findUnique({ where: { id: sessionId } }),
    ]);

    if (!user || user.isBlocked || user.deletedAt) return { status: "invalid_account" };
    if (!session?.isActive || session.userId !== user.id || session.expiresAt < now) {
      return { status: "session_inactive" };
    }

    const tokenHash = hashToken(refreshToken);
    const next = this.tokens.signTokenPair(user, sessionId, session.expiresAt);

    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { tokenHash, sessionId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;

      await tx.refreshToken.create({
        data: {
          tokenHash: hashToken(next.refreshToken),
          userId: user.id,
          sessionId,
          expiresAt: next.refreshExpiresAt,
        },
      });
      return true;
    });

    if (rotated) {
      return {
        status: "rotated",
        tokens: {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          sessionId,
        },
      };
    }

    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    const graceMs = this.env.REFRESH_REUSE_GRACE_SECONDS * 1000;
    if (stored?.usedAt && now.getTime() - stored.usedAt.getTime() <= graceMs) {
      return { status: "concurrent" };
    }

    // Token Reuse Detection: a validly signed but already-rotated/revoked token was replayed.
    // Refresh rotation happens inside one session, so that session IS the token family: revoking
    // it (and its token chain) matches the OAuth 2.0 Security BCP without logging out the
    // user's other, unrelated devices.
    await this.revokeSession(sessionId);
    return { status: "reused" };
  }

  /**
   * Deactivates a session and purges its refresh tokens atomically.
   */
  async revokeSession(sessionId: string): Promise<number> {
    const [sessions] = await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { id: sessionId, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.refreshToken.deleteMany({ where: { sessionId } }),
    ]);
    return sessions.count;
  }

  /**
   * Batch operations that deactivate all sessions of a user (optionally keeping one) and purge
   * their refresh tokens. Returned un-awaited so callers can compose them into one transaction.
   */
  userSessionRevocationOps(userId: string, options?: { exceptSessionId?: string }) {
    const except = options?.exceptSessionId;
    return [
      this.prisma.session.updateMany({
        where: { userId, isActive: true, ...(except && { id: { not: except } }) },
        data: { isActive: false },
      }),
      this.prisma.refreshToken.deleteMany({
        where: except
          ? { userId, OR: [{ sessionId: null }, { sessionId: { not: except } }] }
          : { userId },
      }),
    ] as const;
  }

  /**
   * Deactivates all sessions of a user (optionally keeping one) and purges their refresh tokens.
   * @returns Number of sessions revoked
   */
  async revokeUserSessions(
    userId: string,
    options?: { exceptSessionId?: string },
  ): Promise<number> {
    const [sessions] = await this.prisma.$transaction([
      ...this.userSessionRevocationOps(userId, options),
    ]);
    return sessions.count;
  }
}
