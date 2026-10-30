# ==========================================
# Etapa 1: Dependencias y Compilación
# ==========================================
# Base fijada por digest (builds reproducibles, item 13): actualízala junto con un
# smoke test de `docker run` (Dependabot propone el bump semanalmente).
# Node 24 es LTS (Node 25 es una versión impar, sin LTS y con soporte corto) y
# coincide con `engines.node`, con la CI y con AGENTS.md.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS builder

WORKDIR /app

# Instalar dependencias del sistema requeridas por Prisma / SQLite
RUN apk add --no-cache openssl

# .npmrc lleva solo comentarios (sin overrides: la integración nestjs-zod está
# vendorizada) y vendor/ es la copia local que npm instala con file:
COPY package*.json .npmrc ./
COPY vendor ./vendor/
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
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runner

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
COPY --chown=node:node vendor ./vendor/
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node prisma ./prisma/
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Instalar dependencias de producción (deshabilitando prepare/husky en entorno CI/Docker).
# `prisma` es dependencia de producción: el entrypoint aplica migraciones en el arranque.
USER node
ENV HUSKY=0
# Una sola capa (`RUN`): lo que se borra aquí no queda almacenado en una capa anterior.
#  1. --ignore-scripts también bloqueó la descarga del schema-engine que `prisma migrate
#     deploy` necesita: sin él, el primer arranque intenta descargarlo y FALLA con el sistema
#     de ficheros de solo lectura (`docker run --read-only`). Se reconstruyen SOLO los
#     paquetes de Prisma en el build (scripts puntuales, sin reactivar prepare/husky).
#  2. `typescript` entra en producción como peer opcional de Prisma; ni el cliente ni las
#     migraciones lo necesitan en ejecución: se elimina del runtime.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild @prisma/engines prisma \
  && rm -rf node_modules/typescript node_modules/@typescript \
  && npm cache clean --force
# El runtime solo necesita node: se elimina el toolchain npm (y corepack/yarn de la imagen
# base). Además de reducir la superficie, retira de la imagen las dependencias que npm
# vendoriza consigo mismo (tar, undici, brace-expansion… — con CVEs propios que Trivy
# detecta y que esta plantilla no puede actualizar: son del npm de la imagen base). El
# entrypoint ejecuta la CLI de Prisma con `node node_modules/prisma/build/index.js` (sin npx).
USER root
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node

# Copiar el código compilado y el cliente generado de Prisma
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/src/generated ./src/generated

EXPOSE 3011

# Healthcheck profundo (proceso + latencia SQLite)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
