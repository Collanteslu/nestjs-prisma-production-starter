import type { Features } from "./env";
import type { Env } from "./env";

/**
 * Injection tokens for the validated configuration. The config object is created once
 * (loadEnv/parseEnv) and provided by AppModule.forRoot — no module reads process.env
 * on import, which keeps tests deterministic and allows per-test overrides.
 */
export const APP_ENV = Symbol("APP_ENV");
export const APP_FEATURES = Symbol("APP_FEATURES");

export type AppEnvProvider = { provide: typeof APP_ENV; useValue: Env };
export type AppFeaturesProvider = { provide: typeof APP_FEATURES; useValue: Features };
