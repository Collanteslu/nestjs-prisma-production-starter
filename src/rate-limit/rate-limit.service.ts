import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/client/client";
import { PrismaService } from "../database/prisma.service";

export interface Bucket {
  count: number;
  resetAt: Date;
}

/**
 * Fixed-window counters kept in the database instead of process memory, so rate limits
 * and the login lockout hold across several API instances sharing one database (e.g. Turso).
 * Every operation is a single atomic statement (no read-modify-write in application code).
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Counts one hit against `key`, opening a new window of `windowMs` when none is active.
   * @returns The bucket after the hit
   */
  async hit(key: string, windowMs: number, options: { slide?: boolean } = {}): Promise<Bucket> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = new Date();

      // Atomic increment of a live window; with `slide` the same statement pushes its end
      // forward, so the count and the window it belongs to never disagree
      const updated = await this.prisma.rateLimitBucket.updateMany({
        where: { key, resetAt: { gt: now } },
        data: {
          count: { increment: 1 },
          ...(options.slide && { resetAt: new Date(now.getTime() + windowMs) }),
        },
      });

      if (updated.count === 0) {
        // No live window: drop a stale row (if any) and open a new one
        await this.prisma.rateLimitBucket.deleteMany({ where: { key, resetAt: { lte: now } } });
        try {
          return await this.prisma.rateLimitBucket.create({
            data: { key, count: 1, resetAt: new Date(now.getTime() + windowMs) },
            select: { count: true, resetAt: true },
          });
        } catch (error) {
          // Another instance opened the window first: retry as an increment
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            continue;
          }
          throw error;
        }
      }

      const bucket = await this.prisma.rateLimitBucket.findUnique({
        where: { key },
        select: { count: true, resetAt: true },
      });
      if (bucket) return bucket;
    }
    throw new Error(`Could not update rate limit bucket '${key}'`);
  }

  /** Returns the live bucket for `key`, or null when there is none (or its window has ended) */
  async peek(key: string): Promise<Bucket | null> {
    const bucket = await this.prisma.rateLimitBucket.findUnique({
      where: { key },
      select: { count: true, resetAt: true },
    });
    return bucket && bucket.resetAt.getTime() > Date.now() ? bucket : null;
  }

  /**
   * Pushes the end of a live window forward so it is measured from the LATEST hit
   * (sliding lockout: failures spread across the window must not unlock seconds after the last one).
   */
  async slide(key: string, windowMs: number): Promise<void> {
    const now = new Date();
    await this.prisma.rateLimitBucket.updateMany({
      where: { key, resetAt: { gt: now } },
      data: { resetAt: new Date(now.getTime() + windowMs) },
    });
  }

  async clear(key: string): Promise<void> {
    await this.prisma.rateLimitBucket.deleteMany({ where: { key } });
  }

  /** Deletes buckets whose window has ended. @returns Number of rows purged */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.rateLimitBucket.deleteMany({
      where: { resetAt: { lte: new Date() } },
    });
    return count;
  }
}
