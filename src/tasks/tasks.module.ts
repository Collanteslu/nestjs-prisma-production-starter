import { Module } from "@nestjs/common";
import { TasksController } from "./tasks.controller";

/**
 * `/api/tasks` routes. Mounted in every AUTH_MODE (public and ownerless with
 * AUTH_MODE=none, bearer-protected otherwise).
 */
@Module({
  controllers: [TasksController],
})
export class TasksModule {}
