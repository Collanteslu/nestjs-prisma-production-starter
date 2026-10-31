import { Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import type { AuthUserPayload } from "../auth/auth.types";
import { AuthUser } from "../common/decorators/auth-user.decorator";
import { TopLevelEnvelope } from "../common/decorators/envelope.decorator";
import { PrismaService } from "../database/prisma.service";
import { SessionIdParam } from "./dto/session.dtos";
import { SessionsService } from "./sessions.service";

/**
 * Session management routes. Allows users to inspect every session recorded for their
 * account (the purge of expired and long-inactive rows is left to the cleanup job),
 * terminate specific sessions, or revoke all active sessions immediately.
 *
 * Mounted only when `features.auth` (the module is imported conditionally).
 */
@ApiTags("Sessions")
@ApiBearerAuth()
@Controller("api/sessions")
export class SessionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /api/sessions/me
   * Retrieves all sessions belonging to the currently authenticated user.
   */
  @Get("me")
  @TopLevelEnvelope()
  @ApiOperation({
    summary: "Listar sesiones del usuario actual",
    description:
      "Devuelve todos los dispositivos con sesión registrada por el usuario autenticado, incluidas las sesiones ya revocadas o caducadas que la tarea de limpieza aún no ha purgado.",
  })
  @ApiOkResponse({ description: "Sesiones del usuario" })
  @ApiUnauthorizedResponse({ description: "Token ausente o inválido" })
  async list(@AuthUser() currentUser: AuthUserPayload) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: currentUser.userId },
      orderBy: { createdAt: "desc" },
    });

    return {
      count: sessions.length,
      currentSessionId: currentUser.sessionId,
      data: sessions.map((s) => ({ ...s, isCurrent: s.id === currentUser.sessionId })),
    };
  }

  /**
   * DELETE /api/sessions/:sessionId
   * Terminates a specific session. Tokens tied to this session will be rejected immediately.
   */
  @Delete(":sessionId")
  @ApiOperation({
    summary: "Revocar una sesión específica",
    description:
      "Termina una sesión. Los tokens asociados dejan de funcionar de inmediato. Solo el dueño o un Admin.",
  })
  @ApiOkResponse({ description: "Sesión revocada" })
  @ApiUnauthorizedResponse({ description: "Token ausente o inválido" })
  @ApiNotFoundResponse({ description: "Sesión inexistente o de otro usuario" })
  async revokeOne(
    @Param() params: SessionIdParam,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { sessionId } = params;

    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });

    // Users can only revoke their own sessions (admins can revoke any). A foreign session answers
    // exactly like a missing one so session IDs cannot be probed for existence.
    if (!session || (session.userId !== currentUser.userId && currentUser.role !== "admin")) {
      throw new NotFoundException(`Session with ID '${sessionId}' not found.`);
    }

    await this.sessions.revokeSession(sessionId);

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "REVOKE_SESSION",
      entity: "Session",
      entityId: sessionId,
      details: { ownerId: session.userId },
    });

    return { message: `Session '${sessionId}' has been revoked successfully.`, data: null };
  }

  /**
   * POST /api/sessions/revoke-all
   * Invalidates all active sessions for the current user across all devices.
   */
  @Post("revoke-all")
  @HttpCode(200)
  @ApiOperation({
    summary: "Revocar todas las sesiones del usuario actual",
    description: "Invalida todas las sesiones activas del usuario en todos sus dispositivos.",
  })
  @ApiOkResponse({ description: "Sesiones revocadas" })
  @ApiUnauthorizedResponse({ description: "Token ausente o inválido" })
  async revokeAll(@AuthUser() currentUser: AuthUserPayload, @Req() req: Request) {
    const revokedCount = await this.sessions.revokeUserSessions(currentUser.userId);

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "REVOKE_ALL_SESSIONS",
      entity: "User",
      entityId: currentUser.userId,
      details: { revokedCount },
    });

    return {
      message: "All active sessions have been revoked. You must log in again.",
      data: null,
    };
  }
}
