import { createZodDto } from "nestjs-zod";
import { auditQuerySchema } from "../../schemas/request.schemas";

/** Query DTO of `GET /api/audit-logs` (admin only). */
export class AuditQuery extends createZodDto(auditQuerySchema) {}
