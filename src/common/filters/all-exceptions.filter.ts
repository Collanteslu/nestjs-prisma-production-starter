import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { ZodValidationException, ZodSerializationException } from "nestjs-zod";
import type { ZodError } from "zod";
import {
  INTERNAL_ERROR_MESSAGE,
  MALFORMED_JSON_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
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

    let status = 500;
    let message: string;
    let errors: Record<string, string[]> | undefined;

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
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === "string") {
        message = payload;
      } else if (typeof payload === "object" && payload !== null) {
        const body = payload as { message?: string | string[]; errors?: Record<string, string[]> };
        message = Array.isArray(body.message)
          ? body.message.join(", ")
          : (body.message ?? exception.message);
        errors = body.errors;
      } else {
        message = exception.message;
      }
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
        exception instanceof Error ? exception.message : undefined,
      );
      // Parity: in development the reference implementation leaks err.message.
      message =
        process.env.NODE_ENV !== "production" && exception instanceof Error && exception.message
          ? exception.message
          : INTERNAL_ERROR_MESSAGE;
    }

    res.status(status).json(buildErrorPayload(message, errors));
  }
}
