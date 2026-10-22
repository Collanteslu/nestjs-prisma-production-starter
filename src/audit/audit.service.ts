import { Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../database/prisma.service";

export interface LogAuditOptions {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown> | string;
}

/**
 * Audit logging helper for recording system actions and traceability.
 * Does not throw errors to prevent interrupting user transactions.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(request: Request, options: LogAuditOptions): Promise<void> {
    try {
      const details =
        typeof options.details === "object"
          ? JSON.stringify(options.details)
          : options.details || null;

      await this.prisma.auditLog.create({
        data: {
          userId: options.userId ?? null,
          action: options.action,
          entity: options.entity,
          entityId: options.entityId ?? null,
          details,
          ipAddress: request.ip ?? null,
          userAgent: request.headers["user-agent"] || null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to persist audit log entry: ${String(error)}`);
    }
  }
}

/**
 * Parses a stored audit `details` value, which may be a JSON document or a plain string.
 */
export function parseAuditDetails(details: string | null): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}
