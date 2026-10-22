import { createZodDto } from "nestjs-zod";
import {
  detailQuerySchema,
  idParamSchema,
  permanentQuerySchema,
} from "../../schemas/request.schemas";

/**
 * Path/query DTOs shared by several resource controllers (tasks, users), so the
 * document keeps exactly one definition per shape.
 */
export class IdParam extends createZodDto(idParamSchema) {}
export class PermanentQuery extends createZodDto(permanentQuerySchema) {}
export class DetailQuery extends createZodDto(detailQuerySchema) {}
