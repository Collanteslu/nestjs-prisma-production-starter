import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { AuthUser } from "../common/decorators/auth-user.decorator";
import type { AuthUserPayload } from "../auth/auth.types";
import { comparePassword } from "../common/utils/password";
import { PrismaService } from "../database/prisma.service";
import { RateLimit } from "../rate-limit/rate-limit.decorator";
import { PasswordConfirmLockoutService } from "../rate-limit/password-confirm-lockout.service";
import { MfaService } from "./mfa.service";
import { TotpService } from "./totp.service";
import { MfaDisableRequest, MfaEnableRequest, MfaSetupRequest } from "./dto/mfa.dtos";

/**
 * Two-factor authentication (TOTP) management, mounted under /api/auth/mfa
 * (route parity with the reference's routes/mfa.ts, which exists only with AUTH_MODE=full).
 * Enrolling needs the password, so a stolen access token cannot attach an attacker's authenticator.
 */
@ApiTags("MFA")
@ApiBearerAuth("BearerAuth")
@Controller("api/auth")
export class MfaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
    private readonly mfa: MfaService,
    private readonly confirmLockout: PasswordConfirmLockoutService,
    private readonly audit: AuditService,
  ) {}

  /** Loads the caller with the secrets the MFA flows need */
  private loadUser(id: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id },
      omit: { password: false, totpSecret: false, totpLastStep: false },
    });
  }

  /**
   * POST /api/auth/mfa/setup
   * Generates a new (encrypted) secret and returns it with the otpauth:// URI for the QR.
   * 2FA is not enabled until confirmed via POST /mfa/enable.
   */
  @Post("mfa/setup")
  @HttpCode(200)
  @RateLimit("mfa")
  @ApiOperation({
    summary: "Iniciar el alta de 2FA (TOTP)",
    description:
      "Genera un secreto nuevo (cifrado en base de datos) y devuelve el `secret` y la URI `otpauth://` para mostrarla como QR. El 2FA no se activa hasta confirmar con `POST /mfa/enable`.",
  })
  @ApiOkResponse({ description: "Secreto generado" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Contraseña incorrecta, o cuenta suspendida" })
  @ApiConflictResponse({ description: "El 2FA ya está activo" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async setup(
    @Body() dto: MfaSetupRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { currentPassword } = dto;
    const user = await this.loadUser(currentUser.userId);

    // Same per-account guard as the profile password change: a stolen access token must not get
    // unlimited offline guesses at the password through this endpoint
    const retryAfter = await this.confirmLockout.retryAfterSeconds(user.id);
    if (retryAfter > 0) {
      throw new HttpException(
        `Too many incorrect password confirmations. Try again in ${retryAfter} seconds.`,
        429,
      );
    }
    if (!(await comparePassword(currentPassword, user.password))) {
      await this.confirmLockout.recordFailure(user.id);
      throw new ForbiddenException("Current password is incorrect.");
    }
    await this.confirmLockout.reset(user.id);
    if (user.totpEnabledAt) {
      throw new ConflictException("Two-factor authentication is already enabled.");
    }

    const secret = this.totp.generateTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: this.totp.encryptSecret(secret), totpLastStep: null },
    });
    await this.audit.record(req, {
      userId: user.id,
      action: "MFA_SETUP",
      entity: "User",
      entityId: user.id,
    });

    return { data: { secret, otpauthUrl: this.totp.otpauthUrl(secret, user.email) } };
  }

  /**
   * POST /api/auth/mfa/enable
   * Verifies the first code, activates 2FA, revokes every other session of the account and
   * returns the one-time recovery codes.
   */
  @Post("mfa/enable")
  @HttpCode(200)
  @RateLimit("mfa")
  @ApiOperation({
    summary: "Confirmar y activar el 2FA",
    description:
      "Verifica el primer código de la app, activa el 2FA, cierra el resto de sesiones y devuelve 10 códigos de recuperación (se muestran una sola vez).",
  })
  @ApiOkResponse({ description: "2FA activado" })
  @ApiBadRequestResponse({ description: "Código inválido" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Cuenta suspendida" })
  @ApiConflictResponse({ description: "No hay un alta pendiente o ya está activo" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async enable(
    @Body() dto: MfaEnableRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { code } = dto;
    const user = await this.loadUser(currentUser.userId);

    if (user.totpEnabledAt || !user.totpSecret) {
      throw new ConflictException("There is no pending two-factor setup. Call /mfa/setup first.");
    }
    const step = this.totp.verifyTotp(this.totp.decryptSecret(user.totpSecret), code, null);
    if (step === null) throw new BadRequestException("Invalid two-factor code.");

    const recoveryCodes = this.totp.generateRecoveryCodes();
    const enabled = await this.prisma.$transaction(async (tx) => {
      // Conditional claim: of two concurrent confirmations of the same pending setup only one wins,
      // so the recovery codes it returns are the ones stored
      const claimed = await tx.user.updateMany({
        where: { id: user.id, totpEnabledAt: null, totpSecret: user.totpSecret },
        data: { totpEnabledAt: new Date(), totpLastStep: step },
      });
      if (claimed.count !== 1) return false;

      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.createMany({
        data: recoveryCodes.map((rc) => ({
          userId: user.id,
          codeHash: this.totp.hashRecoveryCode(rc),
        })),
      });
      // Any other device must sign in again, now with the second factor
      await tx.session.updateMany({
        where: { userId: user.id, isActive: true, id: { not: currentUser.sessionId } },
        data: { isActive: false },
      });
      await tx.refreshToken.deleteMany({
        where: {
          userId: user.id,
          OR: [{ sessionId: null }, { sessionId: { not: currentUser.sessionId } }],
        },
      });
      return true;
    });
    if (!enabled) {
      throw new ConflictException("There is no pending two-factor setup. Call /mfa/setup first.");
    }

    await this.audit.record(req, {
      userId: user.id,
      action: "MFA_ENABLED",
      entity: "User",
      entityId: user.id,
    });
    return {
      message: "Two-factor authentication enabled. Store the recovery codes safely.",
      data: { recoveryCodes },
    };
  }

  /**
   * POST /api/auth/mfa/disable
   * Turns off 2FA: requires the password plus a TOTP code or a recovery code.
   */
  @Post("mfa/disable")
  @HttpCode(200)
  @RateLimit("mfa")
  @ApiOperation({
    summary: "Desactivar el 2FA",
    description: "Exige la contraseña y un código TOTP o un código de recuperación.",
  })
  @ApiOkResponse({ description: "2FA desactivado" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Contraseña o código incorrectos, o cuenta suspendida" })
  @ApiConflictResponse({ description: "El 2FA no está activo" })
  @ApiTooManyRequestsResponse({ description: "Rate limit excedido" })
  async disable(
    @Body() dto: MfaDisableRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { currentPassword, code, recoveryCode } = dto;
    const user = await this.loadUser(currentUser.userId);

    if (!user.totpEnabledAt) {
      throw new ConflictException("Two-factor authentication is not enabled.");
    }

    const retryAfter = await this.confirmLockout.retryAfterSeconds(user.id);
    if (retryAfter > 0) {
      throw new HttpException(
        `Too many incorrect password confirmations. Try again in ${retryAfter} seconds.`,
        429,
      );
    }
    if (!(await comparePassword(currentPassword, user.password))) {
      await this.confirmLockout.recordFailure(user.id);
      throw new ForbiddenException("Current password or code is incorrect.");
    }
    await this.confirmLockout.reset(user.id);
    if (!(await this.mfa.verifySecondFactor(user, { code, recoveryCode }))) {
      throw new ForbiddenException("Current password or code is incorrect.");
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    ]);

    await this.audit.record(req, {
      userId: user.id,
      action: "MFA_DISABLED",
      entity: "User",
      entityId: user.id,
    });
    return { message: "Two-factor authentication disabled.", data: null };
  }
}
