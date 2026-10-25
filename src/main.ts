import "reflect-metadata";
import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./configure-app";
import { featuresOf, loadEnv } from "./config/env";
import { PrismaService } from "./database/prisma.service";
import { SeedService } from "./database/seed.service";
import { assertMigrationsUpToDate } from "./database/migrations-guard";
import { CleanupService } from "./jobs/cleanup.service";
import { EmailOutboxService } from "./mail/email-outbox.service";
import { createAppLogger } from "./logging";

/**
 * Explicit boot order (same phases as the Hono starter):
 *   1. config (loadEnv, fail fast)          2. Nest create + HTTP wiring
 *   3. connect (PrismaService.onModuleInit) 4. SQLite pragmas
 *   5. migration-history guard              6. seed
 *   7. graceful shutdown hooks              8. listen
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const features = featuresOf(env);
  // Apply LOG_LEVEL before any log statement (the boot warnings below included)
  Logger.overrideLogger(
    createAppLogger({ level: env.LOG_LEVEL, production: env.NODE_ENV === "production" }),
  );
  const logger = new Logger("Bootstrap");

  // Configuration traps that would otherwise only surface as an incident: both are warnings, not
  // startup failures, because existing deployments must keep booting after an upgrade.
  if (features.accountSecurity && !env.MFA_ENCRYPTION_KEY) {
    logger.warn(
      "MFA_ENCRYPTION_KEY is unset, so TOTP secrets are encrypted with a key derived from JWT_SECRET: rotating JWT_SECRET makes every enrolled authenticator undecryptable and its 2FA login fails. Set a dedicated, stable MFA_ENCRYPTION_KEY.",
    );
  }
  if (env.NODE_ENV === "production" && env.MAIL_TRANSPORT === "log") {
    logger.warn(
      "MAIL_TRANSPORT=log in production writes every password-reset and verification link (a live credential) into the log stream. Use MAIL_TRANSPORT=smtp.",
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bodyParser: false, // body parsing is configured explicitly in configureApp()
    abortOnError: false,
  });
  await configureApp(app, env, features);
  await app.init();

  const prisma = app.get(PrismaService);
  await prisma.applySqlitePragmas();
  try {
    await assertMigrationsUpToDate(prisma);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err), "MigrationsGuard");
    process.exit(1);
  }
  await app.get(SeedService).run();

  // Recurring cleanup job (initial non-blocking cycle + hourly unref'd timer), like the Hono starter
  const cleanup = app.get(CleanupService);
  cleanup.start();
  // Durable email worker: polls the outbox and delivers with bounded retries. Only exists
  // when the recovery flows do (AUTH_MODE=full); pending rows survive restarts either way.
  const outbox = features.accountSecurity ? app.get(EmailOutboxService) : undefined;
  outbox?.start();

  installShutdownHooks(app, () => {
    cleanup.stop();
    outbox?.stop();
  });

  await app.listen(env.PORT, "0.0.0.0");
  Logger.log(`Application is running on: ${await app.getUrl()}`, "Bootstrap");
}

/**
 * Graceful shutdown: close the HTTP server and disconnect Prisma; if the process is
 * still alive after 10s, force the exit (same policy as the Hono starter).
 */
function installShutdownHooks(app: INestApplication, stopJobs: () => void): void {
  const shutdown = (signal: NodeJS.Signals) => () => {
    Logger.log(`Received ${signal}: closing application...`, "Shutdown");
    stopJobs();
    const forceExit = setTimeout(() => {
      Logger.error("Could not close gracefully in 10s: forcing exit", "Shutdown");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    void app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        Logger.error(`Error during shutdown: ${String(err)}`, "Shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
}

void bootstrap();
