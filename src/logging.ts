import { ConsoleLogger } from "@nestjs/common";
import type { LogLevel } from "@nestjs/common";

/**
 * LOG_LEVEL (trace…fatal|silent, the same vocabulary the Hono starter uses for its logger)
 * mapped onto Nest's logger levels: Nest has no `fatal` (it maps to `error`) and no `trace`
 * (it maps to `verbose`).
 */
export function nestLogLevels(level: string | undefined): LogLevel[] {
  const levels: Record<string, LogLevel[]> = {
    silent: [],
    fatal: ["error"],
    error: ["error"],
    warn: ["warn", "error"],
    info: ["log", "warn", "error"],
    debug: ["debug", "log", "warn", "error"],
    trace: ["verbose", "debug", "log", "warn", "error"],
  };
  return levels[level ?? "info"] ?? levels.info;
}

/**
 * The application logger. Colours are an interactive-terminal nicety: in production the
 * output goes to `docker logs` / a log shipper, where ANSI escape sequences only add noise
 * to every line and break plain-text searches.
 */
export function createAppLogger(options: {
  level: string | undefined;
  production: boolean;
}): ConsoleLogger {
  return new ConsoleLogger({
    logLevels: nestLogLevels(options.level),
    colors: !options.production,
  });
}
