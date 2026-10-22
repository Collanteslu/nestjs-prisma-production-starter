import { Module } from "@nestjs/common";
import { AuditController } from "./audit.controller";

/**
 * `/api/audit-logs` routes (admin only). Imported by AppModule only when
 * `features.auth`, which keeps the route exactly as conditional as the
 * reference (absent with AUTH_MODE=none).
 */
@Module({
  controllers: [AuditController],
})
export class AuditLogsModule {}
