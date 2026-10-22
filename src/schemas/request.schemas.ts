import { z } from "zod";

/**
 * Zod v4 request schemas (port of the reference's `src/schemas/index.ts`).
 * Component names in the spec come from the DTO class names (LoginRequest, ...), matching
 * the reference's `.openapi("Name")` registrations. `.meta()` carries examples/descriptions —
 * NEVER `.meta({id})`: registering the root id in zod's globalRegistry makes zod emit the root
 * inside `$defs` and nestjs-zod's cleanupOpenApiDoc aborts on the mismatch (see health.dto.ts).
 */

/** Email normalizado (sin espacios y en minúsculas) para búsquedas y unicidad consistentes. */
const emailField = (formatMessage: string) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .email({ message: formatMessage })
    .meta({ example: "ana@example.com" });

/**
 * Política de contraseñas. bcrypt solo procesa los primeros 72 BYTES (no caracteres): una clave con
 * tildes o emoji se truncaría en silencio, así que el límite real se comprueba en bytes UTF-8.
 */
const passwordField = z
  .string()
  .min(8, { message: "Password must be at least 8 characters long" })
  .max(72, { message: "Password cannot exceed 72 characters" })
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message:
      "Password cannot exceed 72 bytes (accented characters and emoji take more than one)",
  })
  .meta({ example: "password123" });

const nameField = z
  .string()
  .trim()
  .min(2, { message: "Name must be at least 2 characters long" })
  .max(50, { message: "Name cannot exceed 50 characters" })
  .meta({ example: "Ana García" });

const totpCodeField = z.string().regex(/^\d{6}$/, { message: "Code must be 6 digits" });
const recoveryCodeField = z.string().min(5).max(32);
const emailTokenField = z.string().min(20).max(200).meta({ example: "Zm9vYmFy..." });

/**
 * Esquema de validación para el inicio de sesión.
 */
export const loginSchema = z.object({
  email: emailField("Invalid email format"),
  // No se aplica la política de contraseñas en el login para no bloquear cuentas existentes
  password: z
    .string()
    .min(1, { message: "Password is required" })
    .max(200)
    .meta({ example: "password123" }),
  totpCode: totpCodeField.optional().meta({
    description: "Código de 6 dígitos de la app autenticadora (solo si la cuenta tiene 2FA)",
  }),
  recoveryCode: recoveryCodeField.optional().meta({
    description: "Código de recuperación de un solo uso (alternativa a `totpCode`)",
  }),
});

/**
 * Esquema para el registro público de cuentas (siempre con rol "user").
 */
export const registerSchema = z.object({
  name: nameField,
  email: emailField("Invalid email format"),
  password: passwordField,
});

/** Solicitud de recuperación de contraseña */
export const forgotPasswordSchema = z.object({ email: emailField("Invalid email format") });

/** Restablecimiento de contraseña con el token recibido por email */
export const resetPasswordSchema = z.object({ token: emailTokenField, password: passwordField });

/** Verificación de email con el token recibido */
export const verifyEmailSchema = z.object({ token: emailTokenField });

/** Reenvío del email de verificación */
export const resendVerificationSchema = z.object({ email: emailField("Invalid email format") });

/** Inicio del alta de 2FA (exige la contraseña para que un token robado no pueda enrolar un factor) */
export const mfaSetupSchema = z.object({ currentPassword: z.string().min(1).max(200) });

/** Confirmación del alta de 2FA con un primer código */
export const mfaEnableSchema = z.object({ code: totpCodeField });

/** Desactivación de 2FA: contraseña + un código o un código de recuperación */
export const mfaDisableSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    code: totpCodeField.optional(),
    recoveryCode: recoveryCodeField.optional(),
  })
  .refine((data) => Boolean(data.code) !== Boolean(data.recoveryCode), {
    message: "Provide either code or recoveryCode",
  });

/**
 * Esquema para renovar el Access Token con Refresh Token.
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1).max(2048),
});

/**
 * Esquema para cerrar sesión (Logout).
 */
export const logoutSchema = z.object({
  refreshToken: z.string().max(2048).optional(),
});
