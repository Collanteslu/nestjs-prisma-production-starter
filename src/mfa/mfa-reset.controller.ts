import {
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { AdminGuard } from "../auth/admin.guard";
import { AuthUser } from "../common/decorators/auth-user.decorator";
import type { AuthUserPayload } from "../auth/auth.types";
import { IdParam } from "../common/dto/common.dtos";
import { PrismaService } from "../database/prisma.service";
import { SessionsService } from "../sessions/sessions.service";

/**
 * DELETE /api/users/:id/mfa — admin reset for users who lost their device and recovery
 * codes. Mounted under /api/users only when AUTH_MODE=full (route parity with the
 * reference's userMfaRoutes).
 */
@ApiTags("Users")
@ApiBearerAuth("BearerAuth")
@Controller("api/users")
export class MfaResetController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  @Delete(":id/mfa")
  @UseGuards(AdminGuard)
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Desactivar el 2FA de un usuario (Solo Admin)",
    description:
      "Para quien perdió su dispositivo y sus códigos de recuperación. Borra el secreto y los códigos, y cierra todas las sesiones del usuario.",
  })
  @ApiOkResponse({ description: "2FA desactivado" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({
    description:
      "Requiere rol administrador, o el usuario es uno mismo (usa `POST /api/auth/mfa/disable`)",
  })
  @ApiNotFoundResponse({ description: "Usuario no encontrado" })
  @ApiConflictResponse({ description: "El usuario no tiene 2FA" })
  async reset(
    @Param() params: IdParam,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { id } = params;

    // Your own 2FA goes through /mfa/disable, which asks for the password and a code: an admin's
    // stolen access token alone must not be enough to strip the admin's second factor
    if (id === currentUser.userId) {
      throw new ForbiddenException(
        "Use POST /api/auth/mfa/disable to turn off your own two-factor authentication.",
      );
    }

    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.deletedAt) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }
    if (!target.totpEnabledAt) {
      throw new ConflictException("The user has no two-factor authentication.");
    }

    // Clearing the secrets and closing every session of the target are one unit: a user who
    // still holds an active session would otherwise keep acting with the old token
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: id } }),
      ...this.sessions.userSessionRevocationOps(id),
    ]);

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "MFA_RESET",
      entity: "User",
      entityId: id,
    });
    return { message: "Two-factor authentication removed and sessions revoked.", data: null };
  }
}
