import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, Logger, NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import { ZodValidationException, ZodSerializationException } from "nestjs-zod";
import type { ZodError } from "zod";
import { Prisma } from "../../generated/client/client";
import { buildMeta } from "../../instrumentation/request-context";
import { RateLimitedException, RetryAfterException } from "../exceptions/retry-after.exception";
import {
  INTERNAL_ERROR_MESSAGE,
  MALFORMED_JSON_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  REQUEST_FALLBACK_MESSAGE,
  VALIDATION_MESSAGE,
  buildErrorPayload,
  groupZodIssues,
} from "../error-payload";

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

function isBodyParserError(exception: unknown): exception is BodyParserError {
  return (
    exception instanceof SyntaxError &&
    typeof (exception as BodyParserError).type === "string" &&
    ["entity.parse.failed", "entity.too.large"].includes(
      (exception as BodyParserError).type as string,
    )
  );
}

/**
 * Global exception filter → reference error envelope:
 *   { success: false, message, errors?: {field:[messages]}, meta: {...} }
 * with the correct HTTP status (400 validation/malformed, 404, 409, 413, 429, 500...).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status: number;
    let message: string;
    let errors: Record<string, string[]> | undefined;
    let details: unknown;
    let retryAfterSeconds: number | undefined;
    let rateLimitedBody = false;

    if (isBodyParserError(exception)) {
      // Normally handled by the raw-Express error middleware; belt and braces.
      status = exception.type === "entity.too.large" ? 413 : 400;
      message =
        exception.type === "entity.too.large" ? PAYLOAD_TOO_LARGE_MESSAGE : MALFORMED_JSON_MESSAGE;
    } else if (exception instanceof ZodValidationException) {
      status = 400;
      message = VALIDATION_MESSAGE;
      errors = groupZodIssues((exception.getZodError() as ZodError).issues);
    } else if (exception instanceof ZodSerializationException) {
      this.logger.error(
        `Serialization failed: ${JSON.stringify((exception as { zodError?: ZodError }).zodError?.issues ?? [])}`,
      );
      status = 500;
      message = INTERNAL_ERROR_MESSAGE;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Same mapping as the reference error handler (P2002 → 409, P2025 → 404)
      if (exception.code === "P2002") {
        status = 409;
        message = "Conflict: A record with the same unique value already exists.";
      } else if (exception.code === "P2025") {
        status = 404;
        message = "Resource not found.";
      } else {
        this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);
        status = 500;
        message = INTERNAL_ERROR_MESSAGE;
      }
    } else if (exception instanceof RateLimitedException) {
      // The reference limiter answers with its own body shape: top-level retryAfterSeconds
      status = exception.getStatus();
      message = exception.message;
      retryAfterSeconds = exception.retryAfterSeconds;
      rateLimitedBody = true;
    } else if (exception instanceof RetryAfterException) {
      // Standard envelope + Retry-After header (login lockout)
      status = exception.getStatus();
      message = exception.message;
      retryAfterSeconds = exception.retryAfterSeconds;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const request = host.switchToHttp().getRequest<{ method: string; path: string }>();
      // Nest's built-in routing 404 ("Cannot GET /path") is reworded to the reference's
      // not-found envelope: `Route not found: <METHOD> <path>`
      if (exception instanceof NotFoundException && /^Cannot [A-Z]+ /.test(exception.message)) {
        message = `Route not found: ${request.method} ${request.path}`;
      } else {
        const payload = exception.getResponse();
        if (typeof payload === "string") {
          message = payload;
        } else if (typeof payload === "object" && payload !== null) {
          const body = payload as {
            message?: string | string[];
            errors?: Record<string, string[]>;
            details?: unknown;
          };
          message = Array.isArray(body.message)
            ? body.message.join(", ")
            : (body.message ?? exception.message);
          errors = body.errors;
          // e.g. login's {code: "EMAIL_NOT_VERIFIED"} / {code: "MFA_REQUIRED"}
          details = body.details;
        } else {
          message = exception.message;
        }
        if (!message) message = REQUEST_FALLBACK_MESSAGE;
      }
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
        exception instanceof Error ? exception.message : undefined,
      );
      status = 500;
      message = INTERNAL_ERROR_MESSAGE;
      // Parity: the reference leaks err.message under `details`, development only
      if (
        process.env.NODE_ENV === "development" &&
        exception instanceof Error &&
        exception.message
      ) {
        details = exception.message;
      }
    }

    if (retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }
    if (rateLimitedBody) {
      res.status(status).json({
        success: false,
        message,
        retryAfterSeconds,
        meta: buildMeta(),
      });
      return;
    }
    res.status(status).json(buildErrorPayload(message, errors, details));
  }
}
