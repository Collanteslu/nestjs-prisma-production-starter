# ==========================================
# Etapa 1: Dependencias y Compilación
# ==========================================
FROM node:24-alpine AS builder

WORKDIR /app

# Instalar dependencias del sistema requeridas por Prisma / SQLite
RUN apk add --no-cache openssl

# .npmrc lleva legacy-peer-deps=true (excepción documentada de la plantilla)
COPY package*.json .npmrc ./
COPY prisma.config.ts ./
COPY prisma ./prisma/

RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# Generar cliente de Prisma y compilar TypeScript
RUN npx prisma generate
RUN npm run build

# ==========================================
# Etapa 2: Imagen Final Ligera para Producción
# ==========================================
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3011
# Default database on the persistent volume (without this the app falls back to ./dev.db,
# outside the volume, and the data is lost on every redeploy)
ENV DATABASE_URL=file:/app/data/prod.db

RUN apk add --no-cache openssl

# Crear directorio de datos persistente con permisos para el usuario node
RUN mkdir -p /app/data && chown -R node:node /app

COPY --chown=node:node package*.json .npmrc ./
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node prisma ./prisma/
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Instalar dependencias de producción (deshabilitando prepare/husky en entorno CI/Docker).
# `prisma` es dependencia de producción: el entrypoint aplica migraciones en el arranque.
USER node
ENV HUSKY=0
RUN npm ci --omit=dev --ignore-scripts

# Copiar el código compilado y el cliente generado de Prisma
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/src/generated ./src/generated

EXPOSE 3011

# Healthcheck profundo (proceso + latencia SQLite)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
