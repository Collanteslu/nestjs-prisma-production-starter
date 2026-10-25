import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { AdminGuard } from "../auth/admin.guard";
import type { AuthUserPayload } from "../auth/auth.types";
import { AuthUser } from "../common/decorators/auth-user.decorator";
import { DetailQuery, IdParam, PermanentQuery } from "../common/dto/common.dtos";
import { inBackground } from "../common/utils/background";
import { buildPagination } from "../common/utils/pagination";
import { comparePassword, hashPassword } from "../common/utils/password";
import { pseudonym } from "../common/utils/pii";
import { parseFilters, parseSorting } from "../common/utils/query";
import { parseIncludes } from "../common/utils/relations";
import type { Env, Features } from "../config/env";
import { APP_ENV, APP_FEATURES } from "../config/tokens";
import { PrismaService } from "../database/prisma.service";
import type { Prisma, User } from "../generated/client/client";
import { AccountMailService } from "../mail/account-mail.service";
import { AuthTokensService } from "../mail/auth-tokens.service";
import { EmailOutboxService } from "../mail/email-outbox.service";
import { PasswordConfirmLockoutService } from "../rate-limit/password-confirm-lockout.service";
import { SessionsService } from "../sessions/sessions.service";
import {
  BlockUserRequest,
  ChangeRoleRequest,
  CreateUserRequest,
  UpdateUserRequest,
  UserQuery,
} from "./dto/user.dtos";

// Soft-deleted tasks are left out of `?include=tasks` on purpose: the task list hides them the same
// way unless the caller explicitly asks for them. The relation stays unbounded.
const USER_INCLUDES = {
  tasks: { where: { deletedAt: null } },
  sessions: true,
};

/**
 * User account management routes: CRUD, pagination, real-time blocking and bulk
 * session revocation. Password hashes never leave the database layer (global
 * Prisma omit). Mounted only when `features.auth`.
 */
@ApiTags("Users")
@ApiBearerAuth("BearerAuth")
@Controller("api/users")
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly authTokens: AuthTokensService,
    private readonly accountMail: AccountMailService,
    private readonly outbox: EmailOutboxService,
    private readonly confirmLockout: PasswordConfirmLockoutService,
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  /**
   * Returns true when the given user is the only remaining active administrator.
   * Used to prevent locking everyone out of the admin API.
   */
  private async isLastActiveAdmin(
    db: Pick<PrismaService, "user">,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role !== "admin") return false;
    const otherActiveAdmins = await db.user.count({
      where: { role: "admin", isBlocked: false, deletedAt: null, id: { not: user.id } },
    });
    return otherActiveAdmins === 0;
  }

  /**
   * GET /api/users
   * Returns a paginated list of users with search and filtering capabilities (Admin only).
   */
  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: "Listar usuarios (Solo Admin)",
    description:
      "Lista paginada con búsqueda, orden y filtros dinámicos tipados `filter[campo]` sobre `name`, `email`, `role`, `isBlocked` y `createdAt`. Los usuarios eliminados solo aparecen con `includeDeleted=true`.",
  })
  @ApiOkResponse({ description: "Lista paginada de usuarios" })
  @ApiBadRequestResponse({ description: "Parámetros o filtros inválidos" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Requiere rol administrador" })
  async list(@Query() dto: UserQuery, @Query() rawQuery: Record<string, string | undefined>) {
    const { page, limit, search, role, isBlocked, sortBy, order, sort, includeDeleted } = dto;
    const skip = (page - 1) * limit;

    // Apply generic filter[...] parameters first
    const where = parseFilters(rawQuery, {
      allowedFields: {
        name: "string",
        email: "string",
        role: "string",
        isBlocked: "boolean",
        createdAt: "date",
      },
    }) as Prisma.UserWhereInput;

    // Soft delete filter: Exclude soft-deleted users unless requested
    if (includeDeleted !== "true") {
      where.deletedAt = null;
    }

    if (role) {
      where.role = role;
    }

    if (isBlocked !== undefined) {
      where.isBlocked = isBlocked === "true";
    }

    if (search) {
      where.OR = [{ name: { contains: search } }, { email: { contains: search } }];
    }

    // Apply sorting (prioritize ?sort=-field if provided, fallback to sortBy & order)
    const orderBy = (
      sort
        ? parseSorting(sort, { allowedFields: ["createdAt", "name", "email", "role"] })
        : [{ [sortBy]: order }]
    ) as Prisma.UserOrderByWithRelationInput[];

    const include = parseIncludes(rawQuery["include"], USER_INCLUDES);

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, skip, take: limit, orderBy, include }),
    ]);

    return { data: users, pagination: buildPagination(total, page, limit) };
  }

  /**
   * GET /api/users/:id
   * Fetches user profile details by ID (Admin or the user themselves).
   */
  @Get(":id")
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Obtener usuario",
    description: "Perfil de un usuario. Solo Admin o el propio usuario.",
  })
  @ApiOkResponse({ description: "Usuario" })
  @ApiBadRequestResponse({ description: "Parámetros de consulta inválidos" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Requiere rol administrador o ser el propio usuario" })
  @ApiNotFoundResponse({ description: "Usuario no encontrado" })
  async getOne(
    @Param() params: IdParam,
    @Query() dto: DetailQuery,
    @Query() rawQuery: Record<string, string | undefined>,
    @AuthUser() currentUser: AuthUserPayload,
  ) {
    const { id } = params;

    if (currentUser.role !== "admin" && currentUser.userId !== id) {
      throw new ForbiddenException(
        "Forbidden: You do not have permission to view this user profile.",
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      include: parseIncludes(rawQuery["include"], USER_INCLUDES),
    });

    // Soft-deleted accounts are hidden by default (the list does the same); the documented
    // includeDeleted=true parameter is the only way to read one back
    if (!user || (user.deletedAt && dto.includeDeleted !== "true")) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    return user;
  }

  /**
   * POST /api/users
   * Creates a new user with Argon2id-hashed credentials (Admin only).
   * Public self-service sign-up is available at POST /api/auth/register.
   */
  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: "Crear usuario (Solo Admin)",
    description:
      "Permite asignar cualquier rol. El registro público está en `POST /api/auth/register`.",
  })
  @ApiCreatedResponse({ description: "Usuario creado" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Requiere rol administrador" })
  @ApiConflictResponse({ description: "Email duplicado" })
  async create(
    @Body() dto: CreateUserRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { name, email, password, role } = dto;

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new ConflictException(`Email '${email}' is already registered.`);
    }

    const newUser = await this.prisma.user.create({
      data: { name, email, password: await hashPassword(password), role },
    });

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "CREATE",
      entity: "User",
      entityId: newUser.id,
      // Pseudonym: audit details are retained for AUDIT_RETENTION_DAYS and must not
      // duplicate the account list's personal data
      details: { account: pseudonym(this.env.JWT_SECRET, email), role },
    });

    return { message: "User created successfully with hashed credentials.", data: newUser };
  }

  /**
   * PATCH /api/users/:id/block
   * Suspends or reactivates a user account (Admin only).
   * If suspended, all active sessions and refresh tokens are terminated immediately.
   */
  @Patch(":id/block")
  @UseGuards(AdminGuard)
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Suspender o reactivar usuario (Solo Admin)",
    description:
      "Al suspender, todas las sesiones y refresh tokens del usuario se revocan de inmediato. Una cuenta eliminada no puede reactivarse.",
  })
  @ApiOkResponse({ description: "Estado actualizado" })
  @ApiBadRequestResponse({
    description: "Error de validación o intento de suspenderse a uno mismo",
  })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Requiere rol administrador" })
  @ApiNotFoundResponse({ description: "Usuario no encontrado" })
  @ApiConflictResponse({ description: "Una cuenta eliminada no puede reactivarse" })
  async block(
    @Param() params: IdParam,
    @Body() dto: BlockUserRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { id } = params;

    if (currentUser.userId === id) {
      throw new BadRequestException(
        "Invalid action: Administrators cannot suspend their own account.",
      );
    }

    const targetUser = await this.prisma.user.findUnique({ where: { id } });
    if (!targetUser) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    const { isBlocked, reason } = dto;

    if (!isBlocked && targetUser.deletedAt) {
      throw new ConflictException("Invalid action: Deleted accounts cannot be reactivated.");
    }

    // Block + session revocation are atomic, and the last-admin check shares the transaction so two
    // admins suspending each other at the same time cannot both succeed.
    const blocked = await this.prisma.$transaction(async (tx) => {
      if (isBlocked && (await this.isLastActiveAdmin(tx, targetUser))) return null;

      const user = await tx.user.update({
        where: { id },
        data: {
          isBlocked,
          blockedReason: isBlocked ? reason || "Suspended by administrator" : null,
        },
      });
      if (!isBlocked) return { user, revokedSessionsCount: 0 };

      const revoked = await tx.session.updateMany({
        where: { userId: id, isActive: true },
        data: { isActive: false },
      });
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      return { user, revokedSessionsCount: revoked.count };
    });

    if (!blocked) {
      throw new ConflictException("Invalid action: Cannot suspend the last active administrator.");
    }
    const { user: updatedUser, revokedSessionsCount } = blocked;

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: isBlocked ? "BLOCK" : "UNBLOCK",
      entity: "User",
      entityId: id,
      details: { reason: updatedUser.blockedReason, revokedSessionsCount },
    });

    return {
      message: isBlocked
        ? `User '${updatedUser.name}' has been suspended and ${revokedSessionsCount} active session(s) terminated.`
        : `User '${updatedUser.name}' has been reactivated successfully.`,
      data: updatedUser,
    };
  }

  /**
   * PATCH /api/users/:id/role
   * Promotes or demotes a user (Admin only). The last active administrator can never be demoted.
   */
  @Patch(":id/role")
  @UseGuards(AdminGuard)
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Cambiar el rol de un usuario (Solo Admin)",
    description:
      "Asciende a admin o degrada a usuario. Un admin no puede cambiar su propio rol y nunca puede quedarse el sistema sin un administrador activo. El rol se lee de la base de datos en cada petición, por lo que el cambio es inmediato.",
  })
  @ApiOkResponse({ description: "Rol actualizado" })
  @ApiBadRequestResponse({ description: "Error de validación o intento de cambiar el propio rol" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Requiere rol administrador" })
  @ApiNotFoundResponse({ description: "Usuario no encontrado" })
  @ApiConflictResponse({ description: "Es el último administrador activo" })
  async changeRole(
    @Param() params: IdParam,
    @Body() dto: ChangeRoleRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { id } = params;
    const { role } = dto;

    if (currentUser.userId === id) {
      throw new BadRequestException("Invalid action: Administrators cannot change their own role.");
    }

    const targetUser = await this.prisma.user.findUnique({ where: { id } });
    if (!targetUser || targetUser.deletedAt) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (role !== "admin" && (await this.isLastActiveAdmin(tx, targetUser))) return null;
      return tx.user.update({ where: { id }, data: { role } });
    });

    if (!result) {
      throw new ConflictException("Invalid action: Cannot demote the last active administrator.");
    }

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "ROLE_CHANGE",
      entity: "User",
      entityId: id,
      details: { from: targetUser.role, to: role },
    });

    return {
      message: `User '${result.name}' is now ${role === "admin" ? "an administrator" : "a standard user"}.`,
      data: result,
    };
  }

  /**
   * POST /api/users/:id/revoke-sessions
   * Revokes all active sessions for a target user (User self-service or Admin).
   */
  @Post(":id/revoke-sessions")
  @HttpCode(200)
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Revocar todas las sesiones de un usuario",
    description: "Cierra todas las sesiones activas del usuario objetivo. Solo el dueño o Admin.",
  })
  @ApiOkResponse({ description: "Sesiones revocadas" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "Requiere ser el dueño de la cuenta o administrador" })
  async revokeSessions(
    @Param() params: IdParam,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { id } = params;

    if (currentUser.userId !== id && currentUser.role !== "admin") {
      throw new ForbiddenException(
        "Access denied: You can only revoke your own sessions unless you are an administrator.",
      );
    }

    const revokedCount = await this.sessions.revokeUserSessions(id);

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "REVOKE_ALL_SESSIONS",
      entity: "User",
      entityId: id,
      details: { revokedCount },
    });

    return { message: `Revoked ${revokedCount} active session(s) for user.`, data: null };
  }

  /**
   * PUT /api/users/:id
   * Updates user profile information (Admin or the user themselves).
   * Changing the password revokes every other session of the account.
   */
  @Put(":id")
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Actualizar usuario",
    description:
      "Actualiza nombre, email o contraseña. Solo Admin o el propio usuario. Cambiar la contraseña revoca el resto de sesiones de la cuenta.",
  })
  @ApiOkResponse({ description: "Perfil actualizado" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({
    description:
      "Requiere ser el dueño de la cuenta o administrador, o currentPassword ausente/incorrecto",
  })
  @ApiNotFoundResponse({ description: "Usuario no encontrado" })
  @ApiConflictResponse({ description: "Email en uso" })
  @ApiTooManyRequestsResponse({
    description: "Demasiadas confirmaciones de contraseña incorrectas",
  })
  async update(
    @Param() params: IdParam,
    @Body() dto: UpdateUserRequest,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { id } = params;

    if (currentUser.role !== "admin" && currentUser.userId !== id) {
      throw new ForbiddenException(
        "Forbidden: You do not have permission to modify another user's profile.",
      );
    }

    const changes = dto;
    const { name, email, password, currentPassword } = changes;

    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser || existingUser.deletedAt) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    // A stolen access token must not be enough to take over the account: changing your own
    // password or email (the password-reset address) requires the current password. Admins
    // modifying someone else are exempt.
    const emailChanging = Boolean(email && email !== existingUser.email);
    if ((password || emailChanging) && currentUser.userId === id) {
      const retryAfter = await this.confirmLockout.retryAfterSeconds(id);
      if (retryAfter > 0) {
        throw new HttpException(
          `Too many incorrect password confirmations. Try again in ${retryAfter} seconds.`,
          429,
        );
      }
      const stored = await this.prisma.user.findUnique({
        where: { id },
        omit: { password: false },
      });
      const valid =
        !!currentPassword && !!stored && (await comparePassword(currentPassword, stored.password));
      if (!valid) {
        await this.confirmLockout.recordFailure(id);
        throw new ForbiddenException("Current password is missing or incorrect.");
      }
      await this.confirmLockout.reset(id);
    }

    if (email && email !== existingUser.email) {
      const emailTaken = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (emailTaken) {
        throw new ConflictException(`Email '${email}' is already in use by another account.`);
      }
    }

    const updateOp = this.prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        // A new address starts unverified
        ...(emailChanging && { email, emailVerifiedAt: null }),
        ...(password && { password: await hashPassword(password) }),
      },
    });

    // A password change invalidates every other session (keep the caller's own session alive).
    // A password or email change also deletes every pending emailed token (reset / verification
    // links sent before it must not survive it). All of it runs in one transaction.
    let updatedUser: User;
    let revokedSessionsCount = 0;
    if (password) {
      const [user, , revoked] = await this.prisma.$transaction([
        updateOp,
        this.authTokens.deletePendingAuthTokensOp(id),
        ...this.sessions.userSessionRevocationOps(id, {
          exceptSessionId: currentUser.userId === id ? currentUser.sessionId : undefined,
        }),
      ]);
      updatedUser = user;
      revokedSessionsCount = revoked.count;
    } else if (emailChanging) {
      [updatedUser] = await this.prisma.$transaction([
        updateOp,
        this.authTokens.deletePendingAuthTokensOp(id),
      ]);
    } else {
      updatedUser = await updateOp;
    }

    if (emailChanging && this.features.accountSecurity && this.env.MAIL_TRANSPORT !== "none") {
      // Durable delivery for the verification link; the token-less notice to the previous
      // address stays fire-and-forget (nothing single-use is at stake)
      inBackground(async () => {
        await this.outbox.enqueueOp(updatedUser.id, "email_verify");
        this.outbox.kick();
      });
      inBackground(() =>
        this.accountMail.sendEmailChangedNotice({
          name: updatedUser.name,
          email: existingUser.email,
        }),
      );
    }

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: password ? "PASSWORD_CHANGE" : "UPDATE",
      entity: "User",
      entityId: id,
      details: { updatedFields: Object.keys(changes), revokedSessionsCount },
    });

    return { message: "User profile updated successfully.", data: updatedUser };
  }

  /**
   * DELETE /api/users/:id
   * Soft deletes a user account (revoking all sessions), or permanently deletes it with
   * cascading deletion across tasks and sessions when ?permanent=true.
   * Security: Only admins or the account owner can delete an account, and the last
   * active administrator can never be deleted.
   */
  @Delete(":id")
  @ApiParam({ name: "id", description: "Identificador del usuario" })
  @ApiOperation({
    summary: "Eliminar usuario (soft delete por defecto)",
    description:
      "Soft delete revocando todas las sesiones, o borrado físico en cascada con `?permanent=true`. Solo Admin o el propio usuario. El último administrador activo no puede eliminarse.",
  })
  @ApiOkResponse({ description: "Usuario eliminado" })
  @ApiBadRequestResponse({ description: "Parámetros de consulta inválidos" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({
    description: "Requiere ser el dueño de la cuenta o administrador",
  })
  @ApiNotFoundResponse({ description: "Usuario no encontrado" })
  @ApiConflictResponse({ description: "No se puede eliminar al último administrador activo" })
  async remove(
    @Param() params: IdParam,
    @Query() query: PermanentQuery,
    @AuthUser() currentUser: AuthUserPayload,
    @Req() req: Request,
  ) {
    const { id } = params;
    const isPermanent = query.permanent === "true";

    if (currentUser.role !== "admin" && currentUser.userId !== id) {
      throw new ForbiddenException(
        "Forbidden: You do not have permission to delete another user's account.",
      );
    }

    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser || (existingUser.deletedAt && !isPermanent)) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    // The "last admin" check and the delete/soft-delete run in one transaction, so two concurrent
    // removals of the last two admins cannot both pass the check.
    const outcome = await this.prisma.$transaction(async (tx) => {
      if (!existingUser.deletedAt && (await this.isLastActiveAdmin(tx, existingUser))) {
        return { lastAdmin: true as const };
      }

      if (isPermanent) {
        const tasksCount = await tx.task.count({ where: { userId: id } });
        await tx.user.delete({ where: { id } });
        return { lastAdmin: false as const, tasksCount };
      }

      const softDeletedUser = await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), isBlocked: true, blockedReason: "Account deleted" },
      });
      await tx.session.updateMany({
        where: { userId: id, isActive: true },
        data: { isActive: false },
      });
      await tx.refreshToken.deleteMany({ where: { userId: id } });
      return { lastAdmin: false as const, softDeletedUser };
    });

    if (outcome.lastAdmin) {
      throw new ConflictException("Invalid action: Cannot delete the last active administrator.");
    }

    if ("tasksCount" in outcome) {
      await this.audit.record(req, {
        userId: currentUser.userId === id ? null : currentUser.userId,
        action: "DELETE_PERMANENT",
        entity: "User",
        entityId: id,
        details: { account: pseudonym(this.env.JWT_SECRET, existingUser.email) },
      });

      return {
        message: `User '${existingUser.name}' and ${outcome.tasksCount} associated task(s) permanently deleted.`,
        data: existingUser,
      };
    }

    const { softDeletedUser } = outcome;

    await this.audit.record(req, {
      userId: currentUser.userId,
      action: "SOFT_DELETE",
      entity: "User",
      entityId: id,
    });

    return {
      message: `User '${existingUser.name}' soft-deleted and all sessions revoked.`,
      data: softDeletedUser,
    };
  }
}
