/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testRegex: ".*\\.spec\\.ts$",
  moduleFileExtensions: ["js", "json", "ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  // El cliente Prisma 7 generado usa importaciones relativas con extensión .js
  // (estilo ESM); en runtime CJS las resolvemos al .ts real.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFiles: ["<rootDir>/test/setup-env.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/generated/**", "!src/main.ts"],
  coverageDirectory: "coverage",
  // Floors from the security review: coverage of the critical files must not regress.
  // Jest evaluates each keyed path PER FILE, so the list names the files themselves
  // (directory globs would also hit files covered by contract/ rather than Jest).
  coverageThreshold: {
    global: { statements: 60, branches: 46, functions: 54, lines: 60 },
    "./src/rate-limit/rate-limit.guard.ts": { statements: 92, branches: 76, functions: 98, lines: 94 },
    "./src/rate-limit/login-lockout.service.ts": {
      statements: 97,
      branches: 88,
      functions: 97,
      lines: 97,
    },
    "./src/auth/jwt-auth.guard.ts": { statements: 80, branches: 70, functions: 97, lines: 79 },
    "./src/common/middleware/auth-prefix.middleware.ts": {
      statements: 82,
      branches: 64,
      functions: 97,
      lines: 80,
    },
    "./src/common/utils/password.ts": { statements: 77, branches: 96, functions: 64, lines: 77 },
    "./src/common/utils/pii.ts": { statements: 90, branches: 72, functions: 97, lines: 97 },
    "./src/mfa/totp.service.ts": { statements: 94, branches: 75, functions: 92, lines: 95 },
    "./src/mail/email-outbox.service.ts": {
      statements: 82,
      branches: 68,
      functions: 72,
      lines: 88,
    },
    "./src/jobs/cleanup.service.ts": {
      statements: 90,
      branches: 70,
      functions: 75,
      lines: 95,
    },
    "./src/audit/audit.service.ts": { statements: 64, branches: 64, functions: 72, lines: 64 },
  },
  // Los e2e comparten SQLite + rate limits: ejecutarlos en serie (Fase C+).
  maxWorkers: 1,
};
