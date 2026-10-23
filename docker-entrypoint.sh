#!/bin/sh
set -e

# Asegurar que el directorio de la base de datos existe, solo si es un fichero local
# (con una URL remota como postgres://... no hay que crear ningún directorio)
case "$DATABASE_URL" in
  file:*)
    DB_DIR=$(dirname "${DATABASE_URL#file:}")
    if [ "$DB_DIR" != "." ]; then
      mkdir -p "$DB_DIR"
    fi
    ;;
esac

# Aplicar migraciones versionadas (nunca "db push" en producción). Sin toolchain npm en
# la imagen: la CLI de Prisma se ejecuta directamente con node.
PRISMA="node node_modules/prisma/build/index.js"
echo "🚀 Aplicando migraciones de base de datos..."
if ! OUTPUT=$($PRISMA migrate deploy 2>&1); then
  echo "$OUTPUT"
  # El baseline NUNCA es automático: si el esquema existente no coincide con el esperado,
  # atribuirle 0_init como "ya aplicada" le asignaría un historial falso. El baseline es una
  # operación EXPLÍCITA de mantenimiento, tras verificar el esquema y tomar copia de seguridad:
  echo ""
  echo "❌ No se aplicaron las migraciones."
  if echo "$OUTPUT" | grep -q "P3005"; then
    echo "   La base de datos existe SIN historial de migraciones (P3005). Procedimiento manual:"
  fi
  echo "     1. Copia de seguridad del fichero/BD actual."
  echo "     2. Verificar que el esquema existente es el esperado, p. ej.:"
  echo "        node node_modules/prisma/build/index.js migrate diff --from-schema-datasource prisma/schema.prisma --to-schema prisma/schema.prisma"
  echo "     3. Solo si el esquema coincide:  node node_modules/prisma/build/index.js migrate resolve --applied 0_init"
  echo "     4. node node_modules/prisma/build/index.js migrate deploy"
  echo "   Nunca ejecutes resolve en un esquema que no hayas verificado."
  exit 1
fi
echo "$OUTPUT"

# Ejecutar el proceso principal
echo "⚡ Iniciando servidor NestJS..."
exec "$@"
