import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";

/** Global audit-log writer used by every module that records actions. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
