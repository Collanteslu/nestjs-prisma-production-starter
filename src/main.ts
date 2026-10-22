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

/**
 * Explicit boot order (same phases as the reference):
 *   1. config (loadEnv, fail fast)          2. Nest create + HTTP wiring
 *   3. connect (PrismaService.onModuleInit) 4. SQLite pragmas
 *   5. migration-history guard              6. seed
 *   7. graceful shutdown hooks              8. listen
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const features = featuresOf(env);
  const logger = new Logger("Bootstrap");

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

  installShutdownHooks(app);

  await app.listen(env.PORT, "0.0.0.0");
  Logger.log(`Application is running on: ${await app.getUrl()}`, "Bootstrap");
}

/**
 * Graceful shutdown: close the HTTP server and disconnect Prisma; if the process is
 * still alive after 10s, force the exit (same policy as the reference).
 */
function installShutdownHooks(app: INestApplication): void {
  const shutdown = (signal: NodeJS.Signals) => () => {
    Logger.log(`Received ${signal}: closing application...`, "Shutdown");
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
