import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
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
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AuditService } from "../audit/audit.service";
import type { Features } from "../config/env";
import { APP_FEATURES } from "../config/tokens";
import type { Prisma } from "../generated/client/client";
import { PrismaService } from "../database/prisma.service";
import { RequestWithUser } from "../common/decorators/auth-user.decorator";
import { buildPagination } from "../common/utils/pagination";
import { parseFilters, parseSorting } from "../common/utils/query";
import { parseIncludes } from "../common/utils/relations";
import { DetailQuery, IdParam, PermanentQuery } from "../common/dto/common.dtos";
import { CreateTaskRequest, TaskQuery, UpdateTaskRequest } from "./dto/task.dtos";

const TASK_INCLUDES = {
  user: { select: { id: true, name: true, email: true, role: true } },
};

interface Viewer {
  userId: string | null;
  isAdmin: boolean;
}

/**
 * Task management CRUD routes with strict user ownership and pagination.
 *
 * Security model (parity with the reference):
 * - Standard users can ONLY read, create, update and delete tasks they own; a foreign
 *   task answers exactly like a missing one (404), so IDs cannot be probed.
 * - Soft-deleted tasks are hidden (404) unless `?includeDeleted=true` or restored.
 * - Admins may read any task (writes stay owner-only) and list other users' tasks.
 * - With AUTH_MODE=none the routes are public and work on ownerless tasks (userId null).
 */
@ApiTags("Tasks")
@ApiBearerAuth("BearerAuth")
@Controller("api/tasks")
export class TasksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  /** The caller as seen by the ownership checks: nobody (ownerless tasks) with AUTH_MODE=none */
  private viewerOf(req: Request): Viewer {
    if (!this.features.auth) return { userId: null, isAdmin: false };
    const user = (req as RequestWithUser).user;
    return { userId: user?.userId ?? null, isAdmin: user?.role === "admin" };
  }

  /** Loads a task and enforces ownership (404 for missing, foreign or hidden tasks). */
  private async findOwnedTask(id: string, viewer: Viewer, options: { allowDeleted?: boolean }) {
    const task = await this.prisma.task.findUnique({ where: { id } });

    if (!task || (task.deletedAt && !options.allowDeleted)) {
      throw new NotFoundException(`Task with ID '${id}' not found.`);
    }

    // Someone else's task answers exactly like a missing one, so IDs cannot be probed
    if (task.userId !== viewer.userId) {
      throw new NotFoundException(`Task with ID '${id}' not found.`);
    }

    return task;
  }

  /**
   * GET /api/tasks
   * Lists tasks belonging exclusively to the authenticated user with pagination and filters.
   */
  @Get()
  @ApiOperation({
    summary: "Listar tareas del usuario",
    description:
      "Lista paginada de las tareas del usuario autenticado (un Admin puede usar `userId=` o `scope=all` para ver las de otros; el resto recibe 403). Con `AUTH_MODE=none` lista las tareas públicas y `userId`/`scope=all` devuelven 400. Admite filtros dinámicos tipados `filter[campo]` / `filter[campo][operador]` sobre `title`, `description`, `completed` y `createdAt` (operadores: `eq`, `contains`, `in`, `gte`, `lte` según el tipo); valores inválidos devuelven 400.",
  })
  @ApiOkResponse({ description: "Lista paginada de tareas" })
  @ApiBadRequestResponse({
    description: "Parámetros o filtros inválidos (o `userId`/`scope=all` con `AUTH_MODE=none`)",
  })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiForbiddenResponse({ description: "`userId` o `scope=all` sin ser Admin" })
  async list(
    @Query() dto: TaskQuery,
    @Query() rawQuery: Record<string, string | undefined>,
    @Req() req: Request,
  ) {
    const viewer = this.viewerOf(req);
    const { page, limit, search, completed, sortBy, order, sort, includeDeleted } = dto;
    const skip = (page - 1) * limit;

    // Apply generic filter[...] parameters first so they can never override the ownership scope
    const where = parseFilters(rawQuery, {
      allowedFields: {
        title: "string",
        description: "string",
        completed: "boolean",
        createdAt: "date",
      },
    }) as Prisma.TaskWhereInput;

    // Ownership filter: always the token's userId, except that admins may look at another user's
    // tasks (?userId=) or at everyone's (?scope=all). Everyone else asking for that gets 403.
    const { userId: requestedUserId, scope } = dto;
    if (requestedUserId || scope === "all") {
      if (!this.features.auth) {
        throw new BadRequestException("userId and scope=all need AUTH_MODE=basic or full.");
      }
      if (!viewer.isAdmin) {
        throw new ForbiddenException("Only administrators can list other users' tasks.");
      }
      if (requestedUserId) where.userId = requestedUserId;
    } else {
      // The caller's own tasks; with AUTH_MODE=none (no users) the public, ownerless ones
      where.userId = viewer.userId;
    }

    // Soft delete filter: By default, exclude soft-deleted tasks unless explicitly requested
    if (includeDeleted !== "true") {
      where.deletedAt = null;
    }

    if (completed !== undefined) {
      where.completed = completed === "true";
    }

    if (search) {
      where.OR = [{ title: { contains: search } }, { description: { contains: search } }];
    }

    // Apply sorting (prioritize ?sort=-field if provided, fallback to sortBy & order)
    const orderBy = (
      sort
        ? parseSorting(sort, { allowedFields: ["createdAt", "title", "completed"] })
        : [{ [sortBy]: order }]
    ) as Prisma.TaskOrderByWithRelationInput[];

    const include = this.features.auth
      ? parseIncludes(rawQuery["include"], TASK_INCLUDES)
      : undefined;

    const [total, tasks] = await Promise.all([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include,
      }),
    ]);

    return { data: tasks, pagination: buildPagination(total, page, limit) };
  }

  /**
   * GET /api/tasks/:id
   * Retrieves a single task ensuring strict ownership validation.
   * Soft-deleted tasks are only returned with ?includeDeleted=true.
   */
  @Get(":id")
  @ApiParam({ name: "id", description: "Identificador de la tarea" })
  @ApiOperation({
    summary: "Obtener una tarea",
    description:
      "Devuelve una tarea propia (un Admin puede leer cualquiera). Las tareas eliminadas (soft delete) solo se devuelven con `?includeDeleted=true`.",
  })
  @ApiOkResponse({ description: "Tarea" })
  @ApiBadRequestResponse({ description: "Parámetros de consulta inválidos" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiNotFoundResponse({ description: "Tarea no encontrada (o pertenece a otro usuario)" })
  async getOne(
    @Param() params: IdParam,
    @Query() dto: DetailQuery,
    @Query() rawQuery: Record<string, string | undefined>,
    @Req() req: Request,
  ) {
    const { id } = params;
    const viewer = this.viewerOf(req);
    const include = this.features.auth
      ? parseIncludes(rawQuery["include"], TASK_INCLUDES)
      : undefined;

    const task = await this.prisma.task.findUnique({
      where: { id },
      include,
    });

    // Missing, soft-deleted and foreign tasks all answer 404 (no existence oracle for other users' IDs)
    // (administrators may read any task; writes stay owner-only)
    if (
      !task ||
      (task.deletedAt && dto.includeDeleted !== "true") ||
      (task.userId !== viewer.userId && !viewer.isAdmin)
    ) {
      throw new NotFoundException(`Task with ID '${id}' not found.`);
    }

    return task;
  }

  /**
   * POST /api/tasks
   * Creates a new task bound strictly to the authenticated user.
   */
  @Post()
  @ApiOperation({
    summary: "Crear tarea",
    description:
      "Crea una tarea asignada automáticamente al usuario del token (sin dueño con `AUTH_MODE=none`). Genera un AuditLog.",
  })
  @ApiCreatedResponse({ description: "Tarea creada" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  async create(@Body() dto: CreateTaskRequest, @Req() req: Request) {
    const { title, description, completed } = dto;
    const { userId } = this.viewerOf(req);

    const newTask = await this.prisma.task.create({
      data: {
        userId, // Secure assignment from the verified token (null with AUTH_MODE=none)
        title,
        description,
        completed,
      },
    });

    await this.audit.record(req, {
      userId,
      action: "CREATE",
      entity: "Task",
      entityId: newTask.id,
      details: { title: newTask.title },
    });

    return { message: "Task created successfully.", data: newTask };
  }

  /**
   * PUT /api/tasks/:id
   * Updates task properties (title, description, completed) verifying ownership.
   */
  @Put(":id")
  @ApiParam({ name: "id", description: "Identificador de la tarea" })
  @ApiOperation({
    summary: "Actualizar tarea",
    description: "Actualiza título, descripción o estado de una tarea propia. Genera un AuditLog.",
  })
  @ApiOkResponse({ description: "Tarea actualizada" })
  @ApiBadRequestResponse({ description: "Error de validación" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiNotFoundResponse({ description: "Tarea no encontrada (o pertenece a otro usuario)" })
  async update(@Param() params: IdParam, @Body() changes: UpdateTaskRequest, @Req() req: Request) {
    const { id } = params;
    const viewer = this.viewerOf(req);
    await this.findOwnedTask(id, viewer, { allowDeleted: false });

    const updatedTask = await this.prisma.task.update({
      where: { id },
      data: changes,
    });

    await this.audit.record(req, {
      userId: viewer.userId,
      action: "UPDATE",
      entity: "Task",
      entityId: id,
      details: { changedFields: Object.keys(changes) },
    });

    return { message: "Task updated successfully.", data: updatedTask };
  }

  /**
   * POST /api/tasks/:id/restore
   * Restores a soft-deleted task.
   */
  @Post(":id/restore")
  @HttpCode(200)
  @ApiParam({ name: "id", description: "Identificador de la tarea" })
  @ApiOperation({
    summary: "Restaurar tarea eliminada",
    description: "Restaura una tarea eliminada con soft delete.",
  })
  @ApiOkResponse({ description: "Tarea restaurada" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiNotFoundResponse({ description: "Tarea no encontrada (o pertenece a otro usuario)" })
  @ApiConflictResponse({ description: "La tarea no está eliminada" })
  async restore(@Param() params: IdParam, @Req() req: Request) {
    const { id } = params;
    const viewer = this.viewerOf(req);
    const task = await this.findOwnedTask(id, viewer, { allowDeleted: true });

    if (!task.deletedAt) {
      throw new ConflictException("Task is not deleted.");
    }

    const restored = await this.prisma.task.update({ where: { id }, data: { deletedAt: null } });

    await this.audit.record(req, {
      userId: viewer.userId,
      action: "RESTORE",
      entity: "Task",
      entityId: id,
    });

    return { message: "Task restored successfully.", data: restored };
  }

  /**
   * DELETE /api/tasks/:id
   * Soft deletes a task by setting deletedAt timestamp, or permanently deletes if ?permanent=true.
   */
  @Delete(":id")
  @ApiParam({ name: "id", description: "Identificador de la tarea" })
  @ApiOperation({
    summary: "Eliminar tarea (soft delete por defecto)",
    description:
      "Marca `deletedAt` por defecto. Con `?permanent=true` elimina físicamente la tarea (también si ya estaba en soft delete).",
  })
  @ApiOkResponse({ description: "Tarea eliminada (soft delete o permanente)" })
  @ApiBadRequestResponse({ description: "Parámetros de consulta inválidos" })
  @ApiUnauthorizedResponse({ description: "Token ausente, inválido o sesión revocada" })
  @ApiNotFoundResponse({
    description: "Tarea no encontrada (o ya eliminada, salvo con `permanent=true`)",
  })
  async remove(@Param() params: IdParam, @Query() query: PermanentQuery, @Req() req: Request) {
    const { id } = params;
    const isPermanent = query.permanent === "true";
    const viewer = this.viewerOf(req);

    // Permanent deletion is also allowed on already soft-deleted tasks
    await this.findOwnedTask(id, viewer, { allowDeleted: isPermanent });

    if (isPermanent) {
      await this.prisma.task.delete({ where: { id } });

      await this.audit.record(req, {
        userId: viewer.userId,
        action: "DELETE_PERMANENT",
        entity: "Task",
        entityId: id,
      });

      return { message: "Task permanently deleted.", data: { id, deletedPermanently: true } };
    }

    // Soft delete
    const softDeleted = await this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.record(req, {
      userId: viewer.userId,
      action: "SOFT_DELETE",
      entity: "Task",
      entityId: id,
    });

    return { message: "Task soft-deleted successfully.", data: softDeleted };
  }
}
