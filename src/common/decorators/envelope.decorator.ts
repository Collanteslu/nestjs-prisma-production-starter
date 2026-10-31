import { SetMetadata } from "@nestjs/common";

/**
 * Response-envelope control. The global TransformInterceptor wraps handler results
 * in the standard `{success, message?, data, pagination?, meta}` envelope unless the
 * route opts out:
 *
 * - `@NoEnvelope()`      → body returned verbatim (health check, index, raw docs).
 * - `@TopLevelEnvelope()` → handler fields spread at the TOP level together with
 *   `success` + `meta` (login/refresh token responses in the Hono starter API).
 */
export const NO_ENVELOPE_KEY = "contract:noEnvelope";
export const TOP_LEVEL_ENVELOPE_KEY = "contract:topLevelEnvelope";

export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);
export const TopLevelEnvelope = () => SetMetadata(TOP_LEVEL_ENVELOPE_KEY, true);
