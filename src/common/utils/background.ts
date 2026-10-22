import { Logger } from "@nestjs/common";

const logger = new Logger("Background");

/** Runs a task in the background, logging (never throwing) its failures */
export function inBackground(task: () => Promise<unknown>): void {
  void task().catch((error: unknown) =>
    logger.error(`Background account task failed: ${String(error)}`),
  );
}
