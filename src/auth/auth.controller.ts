import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { TopLevelEnvelope } from "../common/decorators/envelope.decorator";
import { Public } from "../common/decorators/public.decorator";
import { RetryAfterException } from "../common/exceptions/retry-after.exception";
import { inBackground } from "../common/utils/background";
import { comparePassword, getDummyHash, hashPassword, needsRehash } from "../common/utils/password";
import { pseudonym } from "../common/utils/pii";
import { hashToken } from "../common/utils/hash-token";
import type { Env, Features } from "../config/env";
import { APP_ENV, APP_FEATURES } from "../config/tokens";
import { PrismaService } from "../database/prisma.service";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { LoginLockoutService } from "../rate-limit/login-lockout.service";
import { MfaService } from "../mfa/mfa.service";
import { EmailOutboxService } from "../mail/email-outbox.service";
import { SessionsService } from "../sessions/sessions.service";
import type { RefreshTokenPayload } from "./auth.types";
import { LoginRequest, LogoutRequest, RefreshTokenRequest, RegisterRequest } from "./dto/auth.dtos";
import { TokensService } from "./tokens.service";

@ApiTags("Auth")
@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
    private readonly lockout: LoginLockoutService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
    private readonly outbox: EmailOutboxService,
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  /**
   * POST /api/auth/register
   * Public self-service registration. Accounts are always created with the "user" role.
   */
  @Post("register")
  @Public()
  @RateLimit("register")
  @ApiOperation({
    summary: "Registro público de cuentas",
    description:
      "Crea una cuenta con rol `user` (cualquier `role` enviado se ignora). Rate limit por IP (5/hora por defecto).",
  })
  @ApiCreatedResponse({ description: "Cuenta creada" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiConflictResponse({ description: "Email duplicado" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async register(@Body() dto: RegisterRequest, @Req() req: Request) {
    const { name, email, password } = dto;

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`Email '${email}' is already registered.`);

    const newUser = await this.prisma.user.create({
      data: { name, email, password: await hashPassword(password), role: "user" },
    });

    await this.audit.record(req, {
      userId: newUser.id,
      action: "REGISTER",
      entity: "User",
      entityId: newUser.id,
    });

    // Email verification is part of AUTH_MODE=full only. The intent is persisted (and the
    // worker delivers it with bounded retries) so a restart cannot silently drop the mail;
    // the gate keeps the previous behaviour of not queueing when nothing can deliver.
    if (this.features.accountSecurity && this.env.MAIL_TRANSPORT !== "none") {
      inBackground(async () => {
        await this.outbox.enqueueOp(newUser.id, "email_verify");
        this.outbox.kick();
      });
    }

    return { message: "Account registered successfully.", data: newUser };
  }

  /**
   * POST /api/auth/login
   * Validates user credentials, ensures account is not blocked, and establishes an active session.
   */
  @Post("login")
  @Public()
  @HttpCode(200)
  @RateLimit("login")
  @TopLevelEnvelope()
  @ApiOperation({
    summary: "Inicio de sesión (Login)",
    description:
      "Autentica credenciales y emite Access Token (15 min) y Refresh Token (7 días). Protegido por rate limit por IP y bloqueo por cuenta tras 5 intentos fallidos (15 min).",
  })
  @ApiOkResponse({ description: "Login exitoso" })
  @ApiBadRequestResponse({ description: "Error de validación o JSON mal formado" })
  @ApiUnauthorizedResponse({
    description:
      "Credenciales inválidas, o falta/es incorrecto el código 2FA (`details.code`: `MFA_REQUIRED` o `MFA_INVALID`)",
  })
  @ApiForbiddenResponse({
    description: "Cuenta suspendida, o email sin verificar (`details.code`: `EMAIL_NOT_VERIFIED`)",
  })
  @ApiTooManyRequestsResponse({
    description: "Rate limit excedido o cuenta bloqueada temporalmente",
  })
  async login(@Body() dto: LoginRequest, @Req() req: Request) {
    const { email, password, totpCode, recoveryCode } = dto;

    const lockedForSeconds = await this.lockout.retryAfterSeconds(email);
    if (lockedForSeconds > 0) {
      throw new RetryAfterException(
        "Too many failed login attempts for this account. Please try again later.",
        429,
        lockedForSeconds,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      // Overrides the client-level omit: the password (and MFA material) is needed here
      omit: { password: false, totpSecret: false, totpLastStep: false },
    });

    // Constant-time bcrypt comparison (always executed to prevent timing side-channel leaks)
    const isValidPassword = await comparePassword(
      password,
      user?.password ?? (await getDummyHash()),
    );

    if (!user || !isValidPassword || user.deletedAt) {
      await this.lockout.recordFailure(email);
      await this.audit.record(req, {
        userId: user?.id ?? null,
        action: "LOGIN_FAILED",
        entity: "Session",
        // Pseudonym, never the raw address: security logs must minimize personal data
        details: { account: pseudonym(this.env.JWT_SECRET, email) },
      });
      throw new UnauthorizedException("Invalid credentials (incorrect email or password)");
    }

    // Verify account suspension status after password check to prevent status enumeration
    if (user.isBlocked) {
      await this.lockout.reset(email);
      throw new ForbiddenException("Account has been suspended. Please contact support.");
    }

    if (this.env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
      await this.lockout.reset(email);
      throw new HttpException(
        {
          message: "Email address not verified. Check your inbox.",
          details: { code: "EMAIL_NOT_VERIFIED" },
        },
        403,
      );
    }

    // Second factor: the password alone is not enough once 2FA is on. A wrong code counts as a
    // failed login (same lockout), a missing one does not.
    if (user.totpEnabledAt) {
      if (!totpCode && !recoveryCode) {
        throw new HttpException(
          { message: "Two-factor code required.", details: { code: "MFA_REQUIRED" } },
          401,
        );
      }
      if (!(await this.mfa.verifySecondFactor(user, { code: totpCode, recoveryCode }))) {
        await this.lockout.recordFailure(email);
        await this.audit.record(req, {
          userId: user.id,
          action: "LOGIN_FAILED",
          entity: "Session",
          details: {
            account: pseudonym(this.env.JWT_SECRET, email),
            reason: "invalid_second_factor",
          },
        });
        throw new HttpException(
          { message: "Invalid two-factor code.", details: { code: "MFA_INVALID" } },
          401,
        );
      }
    }

    // Progressive migration to Argon2id (OWASP Password Storage): a legacy bcrypt hash is
    // re-hashed in place once, only after a fully successful login — never by rewriting
    // stored hashes en masse. Best effort: a write race must not break the login itself.
    if (needsRehash(user.password)) {
      const upgraded = await hashPassword(password);
      await this.prisma.user
        .update({ where: { id: user.id }, data: { password: upgraded } })
        .catch(() => undefined);
    }

    await this.lockout.reset(email);

    const sessionData = await this.sessions.createSessionAndTokens(
      user,
      req.headers["user-agent"],
      req.ip,
    );

    await this.audit.record(req, {
      userId: user.id,
      action: "LOGIN",
      entity: "Session",
      entityId: sessionData.sessionId,
    });

    return {
      message: "Authentication successful",
      ...sessionData,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * POST /api/auth/refresh
   * Exchanges a valid Refresh Token for a new token pair using Token Rotation.
   */
  @Post("refresh")
  @Public()
  @HttpCode(200)
  @RateLimit("refresh")
  @TopLevelEnvelope()
  @ApiOperation({
    summary: "Renovar Access Token (Token Rotation)",
    description:
      "Intercambia un Refresh Token válido por un nuevo par de tokens. Cada refresh token solo puede usarse una vez: reutilizarlo dentro del periodo de gracia devuelve 409 (refresh concurrente); después se considera robo y la sesión se revoca.",
  })
  @ApiOkResponse({ description: "Tokens renovados" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({
    description: "Refresh token inválido, expirado, revocado o reutilizado",
  })
  @ApiForbiddenResponse({ description: "Cuenta suspendida o eliminada" })
  @ApiConflictResponse({ description: "El token ya fue rotado por una petición concurrente" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async refresh(@Body() dto: RefreshTokenRequest, @Req() req: Request) {
    const { refreshToken } = dto;

    let payload: RefreshTokenPayload;
    try {
      payload = this.tokens.verifyRefreshToken(refreshToken);
    } catch {
      throw new UnauthorizedException("Corrupted or invalid refresh token.");
    }

    const result = await this.sessions.rotateRefreshToken(refreshToken, payload);

    switch (result.status) {
      case "rotated":
        return { message: "Tokens renewed successfully (Token Rotation)", ...result.tokens };
      case "invalid_account":
        throw new ForbiddenException(
          "Access denied: Account does not exist or has been suspended.",
        );
      case "session_inactive":
        throw new UnauthorizedException(
          "Session has been revoked or expired. Please sign in again.",
        );
      case "concurrent":
        throw new ConflictException(
          "Refresh token was already rotated by a concurrent request. Use the most recent token pair.",
        );
      case "reused":
        await this.audit.record(req, {
          userId: payload.userId,
          action: "TOKEN_REUSE_DETECTED",
          entity: "Session",
          entityId: payload.sessionId ?? null,
        });
        throw new UnauthorizedException(
          "Security alert: Refresh token has already been used or revoked. Session terminated.",
        );
    }
  }

  /**
   * POST /api/auth/logout
   * Deactivates session record in SQLite and purges associated refresh tokens.
   */
  @Post("logout")
  @Public()
  @HttpCode(200)
  @RateLimit("logout")
  @ApiOperation({
    summary: "Cierre de sesión (Logout)",
    description:
      "Revoca la sesión asociada al Bearer token y/o al refresh token enviado (ambos opcionales).",
  })
  @ApiOkResponse({ description: "Sesión revocada" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  async logout(@Body() dto: LogoutRequest, @Req() req: Request) {
    const { refreshToken } = dto;
    const authHeader = req.headers.authorization;
    const revoked = new Map<string, string>(); // sessionId -> userId

    // 1. If called with a Bearer token, terminate the current session
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = this.tokens.verifyAccessToken(authHeader.slice("Bearer ".length).trim());
        if (payload.sessionId) revoked.set(payload.sessionId, payload.userId);
      } catch {
        // An expired/invalid access token must not prevent logout via refresh token
      }
    }

    // 2. If a refresh token was provided, revoke the session it belongs to
    if (refreshToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(refreshToken) },
      });
      if (stored?.sessionId) revoked.set(stored.sessionId, stored.userId);
      else if (stored) await this.prisma.refreshToken.delete({ where: { id: stored.id } });
    }

    for (const [sessionId, userId] of revoked) {
      await this.sessions.revokeSession(sessionId);
      await this.audit.record(req, {
        userId,
        action: "LOGOUT",
        entity: "Session",
        entityId: sessionId,
      });
    }

    return { message: "Logged out successfully. Session revoked.", data: null };
  }
}
