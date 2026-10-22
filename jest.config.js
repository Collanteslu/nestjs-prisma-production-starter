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
  collectCoverageFrom: ["src/**/*.ts", "!src/generated/**", "!src/main.ts"],
  coverageDirectory: "coverage",
  // Los e2e comparten SQLite + rate limits: ejecutarlos en serie (Fase C+).
  maxWorkers: 1,
};
