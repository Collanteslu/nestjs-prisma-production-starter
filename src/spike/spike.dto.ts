import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * Spike DTOs — exercise the validation matrix required by the plan:
 * nested objects, optional fields, defaults, enums, coercion, ISO datetimes,
 * pattern validation, unknown-field stripping.
 */

export const AddressSchema = z.object({
  city: z.string().min(1),
  zip: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
});

export const SpikeBodySchema = z.object({
  name: z.string().min(2),
  email: z.email(),
  role: z.enum(["user", "admin"]).default("user"),
  profile: AddressSchema.optional(),
  dueAt: z.iso.datetime().optional(),
  retries: z.coerce.number().int().min(0).max(10).default(3),
});

export class SpikeBodyDto extends createZodDto(SpikeBodySchema) {}

export const SpikeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

export class SpikeQueryDto extends createZodDto(SpikeQuerySchema) {}

export const SpikeParamSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, "id must match [A-Za-z0-9._-]"),
});

export class SpikeParamDto extends createZodDto(SpikeParamSchema) {}

/** Serialization DTO: the handler returns an extra field that must NOT survive. */
export const ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
});

export class ItemDto extends createZodDto(ItemSchema) {}
