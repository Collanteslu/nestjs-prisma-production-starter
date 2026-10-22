import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { Public } from "../common/decorators/public.decorator";
import { hashPassword } from "../common/utils/password";
import { inBackground } from "../common/utils/background";
import { PrismaService } from "../database/prisma.service";
import { AccountMailService } from "../mail/account-mail.service";
import { AuthTokensService } from "../mail/auth-tokens.service";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { RateLimitService } from "../rate-limit/rate-limit.service";
import { LoginLockoutService } from "../rate-limit/login-lockout.service";
import { PasswordConfirmLockoutService } from "../rate-limit/password-confirm-lockout.service";
import { SessionsService } from "../sessions/sessions.service";
import {
  ForgotPasswordRequest,
  ResendVerificationRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
} from "../auth/dto/auth.dtos";

const EMAILS_PER_ADDRESS_PER_HOUR = 3;

/**
 * Password recovery and email verification (mounted under /api/auth; exists only when
 * `features.accountSecurity`, i.e. AUTH_MODE=full — route parity with the reference's
 * routes/recovery.ts). Requests that start a flow always answer the same whether or not
 * the account exists, and the email is sent in the background, so neither the body nor
 * the latency reveals which addresses exist.
 */
@ApiTags("Auth")
@Controller("api/auth")
export class RecoveryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authTokens: AuthTokensService,
    private readonly accountMail: AccountMailService,
    private readonly sessions: SessionsService,
    private readonly lockout: LoginLockoutService,
    private readonly confirmLockout: PasswordConfirmLockoutService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** True while the address is under its hourly allowance for this kind of email */
  private async mayEmail(kind: string, email: string): Promise<boolean> {
    const bucket = await this.rateLimit.hit(`mail:${kind}:${email}`, 60 * 60_000);
    return bucket.count <= EMAILS_PER_ADDRESS_PER_HOUR;
  }

  /**
   * POST /api/auth/forgot-password
   * Sends a single-use reset link to an active account. 202 whether or not the account exists.
   */
  @Post("forgot-password")
  @Public()
  @HttpCode(202)
  @RateLimit("forgot-password")
  @ApiOperation({
    summary: "Solicitar recuperación de contraseña",
    description:
      "Si existe una cuenta activa con ese email, se le envía un enlace de un solo uso (válido `PASSWORD_RESET_TTL_MINUTES`). La respuesta es siempre 202, exista o no la cuenta.",
  })
  @ApiOkResponse({ description: "Solicitud aceptada (se responde igual exista o no la cuenta)" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async forgotPassword(@Body() dto: ForgotPasswordRequest, @Req() req: Request) {
    const { email } = dto;

    inBackground(async () => {
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user || user.deletedAt || user.isBlocked) return;
      if (!(await this.mayEmail("reset", email))) return;
      await this.accountMail.sendPasswordResetEmail(user);
      await this.audit.record(req, {
        userId: user.id,
        action: "PASSWORD_RESET_REQUESTED",
        entity: "User",
        entityId: user.id,
      });
    });

    return { message: "If an account exists for that email, a reset link has been sent.", data: null };
  }

  /**
   * POST /api/auth/reset-password
   * Consumes the emailed token: new password, every session and pending token revoked, login unlocked.
   */
  @Post("reset-password")
  @Public()
  @HttpCode(200)
  @RateLimit("reset-password")
  @ApiOperation({
    summary: "Restablecer la contraseña con el token recibido",
    description:
      "Cambia la contraseña, revoca todas las sesiones de la cuenta y desbloquea el login. El 2FA, si está activo, se sigue exigiendo.",
  })
  @ApiOkResponse({ description: "Contraseña restablecida" })
  @ApiBadRequestResponse({
    description: "Token inválido, caducado o ya usado, o contraseña inválida",
  })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async resetPassword(@Body() dto: ResetPasswordRequest, @Req() req: Request) {
    const { token, password } = dto;

    const userId = await this.authTokens.consumeAuthToken(token, "password_reset");
    const user = userId ? await this.prisma.user.findUnique({ where: { id: userId } }) : null;
    if (!user || user.deletedAt || user.isBlocked) {
      throw new BadRequestException("Invalid or expired reset token.");
    }

    // New password + revocation of every session and pending emailed token in one transaction
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          password: await hashPassword(password),
          // Whoever received the email controls the mailbox (the token is bound to this address)
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      }),
      this.authTokens.deletePendingAuthTokensOp(user.id),
      ...this.sessions.userSessionRevocationOps(user.id),
    ]);
    // Unlock the account for the new password: both the login lockout and the password-confirmation
    // lockout (PUT /api/users/:id, /mfa/setup, /mfa/disable) key on this same account
    await this.lockout.reset(user.email);
    await this.confirmLockout.reset(user.id);

    await this.audit.record(req, {
      userId: user.id,
      action: "PASSWORD_RESET",
      entity: "User",
      entityId: user.id,
    });
    return { message: "Password updated. Please sign in again.", data: null };
  }

  /**
   * POST /api/auth/verify-email
   * Consumes the emailed token and marks the address verified (idempotent per token).
   */
  @Post("verify-email")
  @Public()
  @HttpCode(200)
  @RateLimit("verify-email")
  @ApiOperation({ summary: "Verificar el email con el token recibido" })
  @ApiOkResponse({ description: "Email verificado" })
  @ApiBadRequestResponse({ description: "Token inválido, caducado o ya usado" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async verifyEmail(@Body() dto: VerifyEmailRequest, @Req() req: Request) {
    const { token } = dto;

    const userId = await this.authTokens.consumeAuthToken(token, "email_verify");
    if (!userId) throw new BadRequestException("Invalid or expired verification token.");

    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    await this.audit.record(req, { userId, action: "EMAIL_VERIFIED", entity: "User", entityId: userId });
    return { message: "Email verified.", data: null };
  }

  /**
   * POST /api/auth/resend-verification
   * Sends a fresh verification link. 202 whether or not the account exists; max 3 mails per address per hour.
   */
  @Post("resend-verification")
  @Public()
  @HttpCode(202)
  @RateLimit("resend-verification")
  @ApiOperation({
    summary: "Reenviar el email de verificación",
    description: "Respuesta 202 siempre. Máximo 3 correos por dirección y hora.",
  })
  @ApiOkResponse({ description: "Solicitud aceptada (se responde igual exista o no la cuenta)" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async resendVerification(@Body() dto: ResendVerificationRequest, @Req() req: Request) {
    const { email } = dto;

    inBackground(async () => {
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user || user.deletedAt || user.isBlocked || user.emailVerifiedAt) return;
      if (!(await this.mayEmail("verify", email))) return;
      await this.accountMail.sendVerificationEmail(user);
      await this.audit.record(req, {
        userId: user.id,
        action: "VERIFICATION_EMAIL_RESENT",
        entity: "User",
        entityId: user.id,
      });
    });

    return { message: "If the account exists and is not verified, a new link has been sent.", data: null };
  }
}
