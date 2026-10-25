import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Port of the Hono starter's healthResponseSchema (documented as "HealthResponse" there).
 *  NOTE: no `.meta({id})` — registering the root id in zod's globalRegistry makes zod emit
 *  the root inside `$defs`, and nestjs-zod's cleanup then compares that def against the
 *  root rebuilt from the properties record and aborts (they are never deep-equal). */
export const HealthSchema = z.object({
  status: z.enum(["healthy", "unhealthy"]),
  timestamp: z.string(),
  uptimeSeconds: z.number().int().optional(),
  database: z.object({
    status: z.enum(["connected", "disconnected"]),
    latencyMs: z.number().optional(),
  }),
});

export class HealthDto extends createZodDto(HealthSchema) {}
