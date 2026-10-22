import { Global, Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { featuresOf } from "./env";
import type { Env } from "./env";
import { APP_ENV, APP_FEATURES } from "./tokens";

/**
 * Global provider module for the validated configuration. Being @Global, any other
 * module (DatabaseModule included) can inject APP_ENV/APP_FEATURES without importing
 * anything — the config object itself is created once, by AppModule.forRoot(env).
 */
@Global()
@Module({})
export class ConfigProviderModule {
  static forEnv(env: Env): DynamicModule {
    return {
      module: ConfigProviderModule,
      providers: [
        { provide: APP_ENV, useValue: env },
        { provide: APP_FEATURES, useValue: featuresOf(env) },
      ],
      exports: [APP_ENV, APP_FEATURES],
    };
  }
}
