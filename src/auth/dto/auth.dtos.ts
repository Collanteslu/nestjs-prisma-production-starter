import { createZodDto } from "nestjs-zod";
import {
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  mfaDisableSchema,
  mfaEnableSchema,
  mfaSetupSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  refreshTokenSchema,
  verifyEmailSchema,
} from "../../schemas/request.schemas";

/**
 * DTOs validated by the global ContractValidationPipe. Class names ARE the OpenAPI component
 * names, so they match the reference's `.openapi("Name")` registrations one-to-one.
 */
export class LoginRequest extends createZodDto(loginSchema) {}
export class RegisterRequest extends createZodDto(registerSchema) {}
export class RefreshTokenRequest extends createZodDto(refreshTokenSchema) {}
export class LogoutRequest extends createZodDto(logoutSchema) {}
export class ForgotPasswordRequest extends createZodDto(forgotPasswordSchema) {}
export class ResetPasswordRequest extends createZodDto(resetPasswordSchema) {}
export class VerifyEmailRequest extends createZodDto(verifyEmailSchema) {}
export class ResendVerificationRequest extends createZodDto(resendVerificationSchema) {}
export class MfaSetupRequest extends createZodDto(mfaSetupSchema) {}
export class MfaEnableRequest extends createZodDto(mfaEnableSchema) {}
export class MfaDisableRequest extends createZodDto(mfaDisableSchema) {}
