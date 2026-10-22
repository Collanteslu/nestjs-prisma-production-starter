import { Controller, Get, Logger, Res } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { NoEnvelope } from "../common/decorators/envelope.decorator";
import { PrismaService } from "../database/prisma.service";
import { HealthDto } from "./health.dto";

/**
 * Deep healthcheck verifying process uptime and SQLite latency, documented in the
 * OpenAPI spec with the same shape as the reference (tags: System, 200/503). The 503
 * body is a custom shape (no standard error envelope), exactly like the reference.
 */
@ApiTags("System")
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get("healthz")
  @Public()
  @NoEnvelope()
  @ApiOperation({
    summary: "Healthcheck",
    description: "Estado del proceso y latencia de la consulta a SQLite.",
  })
  // Both statuses register the DTO through the SAME @nestjs/swagger pipeline. @ZodResponse
  // would register a second `HealthResponse_Output` variant that collides in cleanupOpenApiDoc;
  // the hand-built body is already type-checked by the HealthDto return type.
  @ApiResponse({ status: 200, type: HealthDto, description: "Servicio saludable" })
  @ApiResponse({ status: 503, type: HealthDto, description: "Base de datos no disponible" })
  async healthz(@Res({ passthrough: true }) res: Response): Promise<HealthDto> {
    try {
      const startTime = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      const dbLatencyMs = Date.now() - startTime;

      res.status(200);
      return {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        database: {
          status: "connected",
          latencyMs: dbLatencyMs,
        },
      };
    } catch (error) {
      // Details are logged server-side only; the public endpoint must not leak internals
      this.logger.error(`Healthcheck database probe failed: ${String(error)}`);
      res.status(503);
      return {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        database: {
          status: "disconnected",
        },
      };
    }
  }
}
