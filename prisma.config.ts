import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config();

// Same URL resolution rules as src/config/env.ts (Turso wins over DATABASE_URL).
const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "file:./dev.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url,
  },
});
