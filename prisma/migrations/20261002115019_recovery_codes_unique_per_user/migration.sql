-- Recovery codes only need to be unique per user (a collision between two users' codes must not
-- make enrolment fail). Existing rows cannot violate the new index: the old one was unique on
-- "codeHash" alone, which is stricter. The composite index also serves the per-user lookups,
-- so the separate "userId" index is dropped.
-- DropIndex
DROP INDEX "RecoveryCode_userId_idx";

-- DropIndex
DROP INDEX "RecoveryCode_codeHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_userId_codeHash_key" ON "RecoveryCode"("userId", "codeHash");
