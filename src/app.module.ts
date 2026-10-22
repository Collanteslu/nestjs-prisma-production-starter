import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor } from "nestjs-zod";
import type { Env } from "./config/env";
import { ConfigProviderModule } from "./config/config.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ContractValidationPipe } from "./common/pipes/contract-validation.pipe";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { DatabaseModule } from "./database/database.module";
import { SeedService } from "./database/seed.service";
import { HealthController } from "./health/health.controller";
import { SystemController } from "./system/system.controller";
import { SpikeController } from "./spike/spike.controller";

/**
 * Application root. Configuration enters through `AppModule.forRoot(env)` — no module
 * reads process.env on import (testable factory, per plan). APP_ENV/APP_FEATURES are
 * published by the global ConfigProviderModule.
 *
 * Global providers follow the reference's pipeline order:
 * guards (auth/rate-limit, added in Fase D) → validation pipe → serializer →
 * envelope interceptor → exception filter.
 *
 * Interceptor registration order matters: TransformInterceptor (envelope) must be
 * OUTSIDE ZodSerializerInterceptor so serialized data is wrapped afterwards.
 */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigProviderModule.forEnv(env), DatabaseModule],
      controllers: [HealthController, SystemController, SpikeController],
      providers: [
        SeedService,
        { provide: APP_PIPE, useClass: ContractValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
