import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Features } from "../config/env";
import type { Env } from "../config/env";
import { APP_ENV, APP_FEATURES } from "../config/tokens";
import { hashPassword } from "../common/utils/password";
import { pseudonym } from "../common/utils/pii";
import { PrismaService } from "./prisma.service";

/**
 * Database seeder executed during application startup (after the migration guard).
 * Seeds initial demo accounts and tasks with hashed passwords if the database is empty.
 * Security: disabled in production to prevent hardcoded demo credentials.
 *
 * Demo data is intentionally IDENTICAL to the Hono starter: the contract
 * suite pins seeded ids and titles (e.g. "Design Frontend UI"), so the fixtures must
 * match byte-for-byte to demonstrate parity.
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(APP_FEATURES) private readonly features: Features,
  ) {}

  async run(): Promise<void> {
    // AUTH_MODE=none has no users: outside production, seed a couple of public example tasks
    if (!this.features.auth) {
      if (this.env.NODE_ENV === "production") return;
      if ((await this.prisma.task.count({ where: { userId: null } })) === 0) {
        await this.prisma.task.createMany({
          data: [
            {
              title: "Explore the public API",
              description: "AUTH_MODE=none: every route is public and tasks have no owner.",
            },
            {
              title: "Turn authentication on",
              description: "Set AUTH_MODE=basic or full to add users, sessions and roles.",
            },
          ],
        });
        this.logger.log("🌱 AUTH_MODE=none: seeded public example tasks");
      }
      return;
    }

    const usersCount = await this.prisma.user.count();

    // In production, optionally bootstrap the primary administrator if environment
    // credentials are provided
    if (this.env.NODE_ENV === "production") {
      if (usersCount === 0 && this.env.ADMIN_EMAIL && this.env.ADMIN_PASSWORD) {
        this.logger.log(
          `👑 Bootstrapping initial production administrator (account=${pseudonym(
            this.env.JWT_SECRET,
            this.env.ADMIN_EMAIL,
          )})...`,
        );
        const hashedPassword = await hashPassword(this.env.ADMIN_PASSWORD);
        await this.prisma.user.create({
          data: {
            name: "System Admin",
            email: this.env.ADMIN_EMAIL.toLowerCase(),
            password: hashedPassword,
            role: "admin",
            emailVerifiedAt: new Date(),
          },
        });
        this.logger.log("✔ Production administrator created successfully.");
      } else {
        this.logger.log("🔒 Production mode active: Demo seeder disabled.");
      }
      return;
    }

    if (usersCount === 0) {
      this.logger.log("🌱 Initializing database with default seeded accounts and tasks...");

      const hashedPassword = await hashPassword("password123");

      // 1. Create Admin User
      const admin = await this.prisma.user.create({
        data: {
          id: "user-1",
          name: "Luis Admin",
          email: "admin@example.com",
          password: hashedPassword,
          role: "admin",
          emailVerifiedAt: new Date(),
          tasks: {
            create: [
              {
                id: "task-1",
                title: "Learn Hono Framework",
                description: "Understand router, middlewares, and context in Hono.",
                completed: false,
              },
              {
                id: "task-2",
                title: "Configure JWT and Roles",
                description: "Protect private routes using authentication middleware.",
                completed: true,
              },
            ],
          },
        },
      });

      // 2. Create Standard User
      const user = await this.prisma.user.create({
        data: {
          id: "user-2",
          name: "Ana García",
          email: "ana@example.com",
          password: hashedPassword,
          role: "user",
          emailVerifiedAt: new Date(),
          tasks: {
            create: [
              {
                id: "task-3",
                title: "Design Frontend UI",
                description: "Build web dashboard consuming the REST API.",
                completed: false,
              },
            ],
          },
        },
      });

      this.logger.log(
        `✔ Database seeded successfully (Admin: ${admin.email}, User: ${user.email})`,
      );
    }
  }
}
