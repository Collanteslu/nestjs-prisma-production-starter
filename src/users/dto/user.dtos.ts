import { createZodDto } from "nestjs-zod";
import {
  blockUserSchema,
  changeRoleSchema,
  createUserSchema,
  updateUserSchema,
  userQuerySchema,
} from "../../schemas/request.schemas";

/** DTOs validated by the global ContractValidationPipe; class names match the Hono starter components. */
export class UserQuery extends createZodDto(userQuerySchema) {}
export class CreateUserRequest extends createZodDto(createUserSchema) {}
export class UpdateUserRequest extends createZodDto(updateUserSchema) {}
export class BlockUserRequest extends createZodDto(blockUserSchema) {}
export class ChangeRoleRequest extends createZodDto(changeRoleSchema) {}
