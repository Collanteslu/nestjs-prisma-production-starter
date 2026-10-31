import { createZodDto } from "nestjs-zod";
import { mfaDisableSchema, mfaEnableSchema, mfaSetupSchema } from "../../schemas/request.schemas";

/** DTOs validated by the global ContractValidationPipe; class names match the Hono starter shapes. */
export class MfaSetupRequest extends createZodDto(mfaSetupSchema) {}
export class MfaEnableRequest extends createZodDto(mfaEnableSchema) {}
export class MfaDisableRequest extends createZodDto(mfaDisableSchema) {}
