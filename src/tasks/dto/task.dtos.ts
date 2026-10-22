import { createZodDto } from "nestjs-zod";
import { createTaskSchema, taskQuerySchema, updateTaskSchema } from "../../schemas/request.schemas";

/** DTOs validated by the global ContractValidationPipe; class names match the reference components. */
export class CreateTaskRequest extends createZodDto(createTaskSchema) {}
export class UpdateTaskRequest extends createZodDto(updateTaskSchema) {}
export class TaskQuery extends createZodDto(taskQuerySchema) {}
