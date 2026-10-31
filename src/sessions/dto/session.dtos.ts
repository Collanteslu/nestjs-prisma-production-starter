import { z } from "zod";
import { createZodDto } from "nestjs-zod";

/** Path param schema (parity with the Hono starter's sessionIdParamSchema) */
const sessionIdParamSchema = z.object({
  sessionId: z.string(),
});

export class SessionIdParam extends createZodDto(sessionIdParamSchema) {}
