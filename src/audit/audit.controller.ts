import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard } from "../auth/admin.guard";
import { buildPagination } from "../common/utils/pagination";
import type { Prisma } from "../generated/client/client";
import { PrismaService } from "../database/prisma.service";
import { AuditService, parseAuditDetails } from "./audit.service";
import { AuditQuery } from "./dto/audit.dtos";

/**
 * Audit-log query endpoint, restricted to administrators (mounted only when
 * `features.auth`). Entries are ordered newest-first; `details` is a stored
 * JSON document and is returned parsed. The embedded user carries no secrets
 * (global Prisma omit + explicit select).
 */
@ApiTags("Audit")
@ApiBearerAuth("BearerAuth")
@Controller("api/audit-logs")
@UseGuards(AdminGuard)
export class AuditController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * GET /api/audit-logs
   * Returns a paginated, filterable history of every recorded action.
   */
  @Get()
  @ApiOperation({
    summary: "Consultar registros de auditoría (Solo Admin)",
    description:
      "Acciones registradas: LOGIN, LOGIN_FAILED, LOGOUT, REGISTER, CREATE, UPDATE, PASSWORD_CHANGE, PASSWORD_RESET_REQUESTED, PASSWORD_RESET, EMAIL_VERIFIED, MFA_ENABLED, MFA_DISABLED, MFA_RESET, ROLE_CHANGE, SOFT_DELETE, RESTORE, DELETE_PERMANENT, BLOCK, UNBLOCK, REVOKE_SESSION, REVOKE_ALL_SESSIONS, TOKEN_REUSE_DETECTED.",
  })
  @ApiOkResponse({ description: "Lista paginada de logs de auditoría" })
  async list(@Query() dto: AuditQuery) {
    const { page, limit, entity, action, userId } = dto;

    const where: Prisma.AuditLogWhereInput = {};
    if (entity) where.entity = entity;
    if (action) where.action = action;
    if (userId) where.userId = userId;

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      }),
    ]);

    return {
      data: logs.map((log) => ({ ...log, details: parseAuditDetails(log.details) })),
      pagination: buildPagination(total, page, limit),
    };
  }
}
