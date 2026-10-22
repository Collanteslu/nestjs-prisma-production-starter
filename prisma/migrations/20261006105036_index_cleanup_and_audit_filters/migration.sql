-- Index-only change: no table is rewritten and no data is discarded. The three dropped indexes are
-- superseded by the composites created below (same leading columns, plus the ordering column the
-- query actually sorts by), so no lookup loses an index.

-- DropIndex
DROP INDEX "AuditLog_userId_idx";

-- DropIndex
DROP INDEX "AuditLog_entity_action_idx";

-- DropIndex
DROP INDEX "Task_userId_deletedAt_idx";

-- CreateIndex
CREATE INDEX "AuditLog_entity_createdAt_idx" ON "AuditLog"("entity", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthToken_usedAt_idx" ON "AuthToken"("usedAt");

-- CreateIndex
CREATE INDEX "RecoveryCode_usedAt_idx" ON "RecoveryCode"("usedAt");

-- CreateIndex
CREATE INDEX "Task_userId_deletedAt_createdAt_idx" ON "Task"("userId", "deletedAt", "createdAt");
