import { z } from "zod";

/**
 * Zod v4 request schemas (port of the Hono starter's `src/schemas/index.ts`).
 * Component names in the spec come from the DTO class names (LoginRequest, ...), matching
 * the Hono starter's `.openapi("Name")` registrations. `.meta()` carries examples/descriptions —
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
 * Política de contraseñas. Los hashes bcrypt heredados (que se siguen verificando y se migran a
 * Argon2id al iniciar sesión) solo procesan los primeros 72 BYTES (no caracteres): una clave con
 * tildes o emoji se truncaría en silencio, así que el límite real se comprueba en bytes UTF-8.
 */
const passwordField = z
  .string()
  .min(8, { message: "Password must be at least 8 characters long" })
  .max(72, { message: "Password cannot exceed 72 characters" })
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password cannot exceed 72 bytes (accented characters and emoji take more than one)",
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

/** Parámetros de paginación compartidos por los listados */
const listParams = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  sort: z.string().optional().meta({
    description: "Orden multi-campo, p. ej. `-createdAt,title`",
    example: "-createdAt",
  }),
  include: z.string().optional().meta({ description: "Relaciones separadas por comas" }),
  includeDeleted: z.enum(["true", "false"]).optional(),
};

/**
 * Esquema de consulta para tareas con paginación, filtros y búsqueda.
 * Los filtros dinámicos `filter[campo]` / `filter[campo][operador]` se leen directamente de la query.
 */
export const taskQuerySchema = z.object({
  ...listParams,
  completed: z.enum(["true", "false"]).optional(),
  sortBy: z.enum(["createdAt", "title", "completed"]).default("createdAt"),
  userId: z.string().min(1).max(100).optional().meta({
    description: "Solo Admin: lista las tareas de ese usuario en lugar de las propias",
  }),
  scope: z.enum(["own", "all"]).default("own").meta({
    description: "Solo Admin: `all` lista las tareas de todos los usuarios",
  }),
});

/** Query de detalle (GET /api/tasks/:id) */
export const detailQuerySchema = z.object({
  include: z.string().optional().meta({ description: "Relaciones separadas por comas" }),
  includeDeleted: z.enum(["true", "false"]).optional(),
});

/** Esquema para crear una tarea */
export const createTaskSchema = z.object({
  title: z
    .string()
    .min(3, { message: "Title must be at least 3 characters long" })
    .max(100, { message: "Title cannot exceed 100 characters" })
    .meta({ example: "Diseñar interfaz frontend" }),
  description: z
    .string()
    .max(2000, { message: "Description cannot exceed 2000 characters" })
    .optional()
    .default(""),
  completed: z.boolean().optional().default(false),
});

/** Esquema para actualizar una tarea existente */
export const updateTaskSchema = z
  .object({
    title: z.string().min(3).max(100).optional(),
    description: z.string().max(2000).optional(),
    completed: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update (title, description or completed)",
  });

/** Parámetro de ruta `:id` */
export const idParamSchema = z.object({
  id: z.string().meta({ example: "user-1" }),
});

/** Opción `?permanent=true` para borrados físicos */
export const permanentQuerySchema = z.object({
  permanent: z.enum(["true", "false"]).optional().meta({ description: "Borrado físico" }),
});

/** Esquema de consulta para usuarios con paginación y búsqueda */
export const userQuerySchema = z.object({
  ...listParams,
  role: z.enum(["admin", "user"]).optional(),
  isBlocked: z.enum(["true", "false"]).optional(),
  sortBy: z.enum(["createdAt", "name", "email", "role"]).default("createdAt"),
});

/** Esquema para cambiar el rol de un usuario */
export const changeRoleSchema = z.object({
  role: z.enum(["admin", "user"]).meta({ example: "admin" }),
});

/** Esquema para crear un nuevo usuario (admin) */
export const createUserSchema = z.object({
  name: nameField,
  email: emailField("Invalid email format"),
  password: passwordField,
  role: z.enum(["admin", "user"]).optional().default("user"),
});

/** Esquema para actualizar un usuario existente */
export const updateUserSchema = z
  .object({
    name: nameField.optional(),
    email: emailField("Invalid email format").optional(),
    password: passwordField.optional(),
    currentPassword: z.string().min(1).max(200).optional().meta({
      description:
        "Contraseña actual. Obligatoria al cambiar la propia contraseña o el propio email; un admin que modifica a otro usuario no la necesita.",
      example: "password123",
    }),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update (name, email or password)",
  });

/** Esquema para bloquear o desbloquear un usuario */
export const blockUserSchema = z.object({
  isBlocked: z.boolean(),
  reason: z.string().max(255).optional().meta({ example: "Violación de términos" }),
});

/** Query de `GET /audit-logs` */
export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  entity: z.string().optional().meta({ example: "Task" }),
  action: z.string().optional().meta({ example: "SOFT_DELETE" }),
  userId: z.string().optional(),
});
