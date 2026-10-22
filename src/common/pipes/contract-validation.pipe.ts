import { HttpException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ArgumentMetadata } from "@nestjs/common";
import { ZodValidationException } from "nestjs-zod";
import { ZodValidationPipe } from "nestjs-zod";
import type { ZodError } from "zod";
import { VALIDATION_MESSAGE, groupZodIssues } from "../error-payload";

/**
 * Reference parity: the message of a validation 400 depends on WHERE the failure
 * happened (`defaultHook` in the original):
 *
 *   body  → "Validation error in request payload"
 *   query → "Invalid request query parameters"
 *   param → "Invalid request params parameters"
 *
 * nestjs-zod's ZodValidationException only carries the ZodError, so the wrapper
 * rethrows an HttpException carrying the target-specific message plus the issues
 * grouped by field (same shape as `formatIssues` in the reference).
 */
@Injectable()
export class ContractValidationPipe implements PipeTransform {
  private readonly inner = new ZodValidationPipe();

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    try {
      return this.inner.transform(value, metadata);
    } catch (err) {
      if (err instanceof ZodValidationException) {
        const message =
          metadata.type === "body"
            ? VALIDATION_MESSAGE
            : `Invalid request ${metadata.type === "param" ? "params" : "query"} parameters`;
        const errors = groupZodIssues((err.getZodError() as ZodError).issues);
        throw new HttpException({ message, errors }, 400);
      }
      throw err;
    }
  }
}
