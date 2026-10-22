import { buildMeta } from "../instrumentation/request-context";

/**
 * Single builder for error bodies, shared by the global exception filter and the
 * raw-Express body-parser error middleware (body parsing happens BEFORE the Nest
 * pipeline, so the filter never sees those errors).
 *
 * Parity with the reference API (verified against the frozen baseline), mirroring
 * `errorSchema` in the original:
 *   { success: false, message, details?, errors?, retryAfterSeconds?, meta }
 * (no `statusCode` field — HTTP status is carried by the response itself).
 */
export const MALFORMED_JSON_MESSAGE = "Malformed JSON in request body";
export const PAYLOAD_TOO_LARGE_MESSAGE =
  "Payload Too Large: Request body exceeds the maximum permitted limit of 100 KB.";
export const VALIDATION_MESSAGE = "Validation error in request payload";
export const INTERNAL_ERROR_MESSAGE = "Internal server error";

export const BODY_LIMIT_BYTES = 100 * 1024;

/**
 * Groups Zod issues by field path — exact reference format:
 * `{ "email": ["Invalid email"], "profile.city": ["Required"], "_root": [...] }`
 */
export function groupZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join(".") || "_root";
    (errors[path] ??= []).push(issue.message);
  }
  return errors;
}

export function buildErrorPayload(
  message: string,
  errors?: Record<string, string[]>,
): Record<string, unknown> {
  const meta = buildMeta();
  return {
    success: false,
    message,
    ...(errors && Object.keys(errors).length > 0 ? { errors } : {}),
    ...(meta ? { meta } : {}),
  };
}
