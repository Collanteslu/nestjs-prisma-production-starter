import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ZodSerializerInterceptor } from "nestjs-zod";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ContractValidationPipe } from "./common/pipes/contract-validation.pipe";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import { SpikeController } from "./spike/spike.controller";

/**
 * Application root. Global providers follow the reference's pipeline order:
 * guards (auth/rate-limit, added in Fase C+) → validation pipe → serializer →
 * envelope interceptor → exception filter.
 *
 * Interceptor registration order matters: TransformInterceptor (envelope) must be
 * OUTSIDE ZodSerializerInterceptor so serialized data is wrapped afterwards.
 */
@Module({
  controllers: [SpikeController],
  providers: [
    { provide: APP_PIPE, useClass: ContractValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
