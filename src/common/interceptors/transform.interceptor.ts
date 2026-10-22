import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable, StreamableFile } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, map } from "rxjs";
import { NO_ENVELOPE_KEY, TOP_LEVEL_ENVELOPE_KEY } from "../decorators/envelope.decorator";
import { buildMeta } from "../../instrumentation/request-context";

interface EnvelopeParts {
  data?: unknown;
  message?: string;
  pagination?: unknown;
}

function isEnvelopeParts(body: unknown): body is EnvelopeParts {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    ("data" in body || "pagination" in body)
  );
}

/**
 * Standard response envelope (parity with the reference API):
 *
 *   { success: true, message?, data, pagination?, meta: {requestId, timestamp, durationMs, apiVersion} }
 *
 * Handlers return either the raw entity/array (wrapped under `data`) or an object
 * `{message?, data, pagination?}` when a message or pagination metadata applies.
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const handler = context.getHandler();
    const controller = context.getClass();
    const noEnvelope = this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [
      handler,
      controller,
    ]);
    const topLevel = this.reflector.getAllAndOverride<boolean>(TOP_LEVEL_ENVELOPE_KEY, [
      handler,
      controller,
    ]);

    if (noEnvelope) return next.handle();

    return next.handle().pipe(
      map((body: unknown) => {
        if (body instanceof StreamableFile) return body;
        const meta = buildMeta();
        if (topLevel) {
          const parts = typeof body === "object" && body !== null ? body : {};
          return { success: true, ...parts, meta };
        }
        if (isEnvelopeParts(body)) {
          const { data, message, pagination } = body;
          return {
            success: true,
            ...(message !== undefined ? { message } : {}),
            data,
            ...(pagination !== undefined ? { pagination } : {}),
            meta,
          };
        }
        return { success: true, data: body, meta };
      }),
    );
  }
}
