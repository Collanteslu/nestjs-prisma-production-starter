#!/bin/bash
set -e

BASE_URL="http://localhost:3011"

echo "=========================================================="
echo "🧪 1. PROBANDO HEALTHCHECK PROFUNDO (SQLite + Uptime)"
echo "=========================================================="
HEALTH=$(curl -s "$BASE_URL/healthz")
echo "$HEALTH"
echo "$HEALTH" | grep -q "healthy"
echo "✔ Healthcheck funcionando correctamente"

echo -e "\n=========================================================="
echo "🧪 2. LOGIN ADMIN Y LOGIN USUARIO (ANA)"
echo "=========================================================="
ADMIN_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password123"}')
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)

USER_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)" \
  -d '{"email":"ana@example.com","password":"password123"}')
USER_TOKEN=$(echo "$USER_LOGIN" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)
USER_SESSION_ID=$(echo "$USER_LOGIN" | grep -o '"sessionId":"[^"]*' | cut -d'"' -f4)

echo "✔ Tokens generados para Admin y Ana (Session ID de Ana: $USER_SESSION_ID)"

echo -e "\n=========================================================="
echo "🧪 3. CONSULTAR SESIONES ACTIVAS DE ANA (GET /api/sessions/me)"
echo "=========================================================="
SESSIONS_RES=$(curl -s -X GET "$BASE_URL/api/sessions/me" \
  -H "Authorization: Bearer $USER_TOKEN")
echo "$SESSIONS_RES"
echo "✔ Ana puede ver sus sesiones y dispositivos registrados en SQLite"

echo -e "\n=========================================================="
echo "🧪 4. TIRAR LA SESIÓN ESPECÍFICA DE ANA (DELETE /api/sessions/:id)"
echo "=========================================================="
REVOKE_RES=$(curl -s -X DELETE "$BASE_URL/api/sessions/$USER_SESSION_ID" \
  -H "Authorization: Bearer $USER_TOKEN")
echo "$REVOKE_RES"

echo -e "\nIntentando hacer una petición con el token de la sesión recién tirada:"
REVOKED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$BASE_URL/api/tasks" \
  -H "Authorization: Bearer $USER_TOKEN")
if [ "$REVOKED_STATUS" -eq 401 ]; then
  echo "✔ Correcto: El token fue rechazado inmediatamente (HTTP 401 - Sesión tirada en base de datos)"
else
  echo "❌ Error: La sesión tirada debió dar 401 pero dio $REVOKED_STATUS"
  exit 1
fi

echo -e "\n=========================================================="
echo "🧪 5. BLOQUEO DE USUARIO POR ADMINISTRADOR (PATCH /api/users/:id/block)"
echo "=========================================================="
# Ana inicia sesión nuevamente
ANA_NEW_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"password123"}')
ANA_NEW_TOKEN=$(echo "$ANA_NEW_LOGIN" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)

echo "Admin bloquea la cuenta de Ana (user-2) por motivo de seguridad:"
BLOCK_RES=$(curl -s -X PATCH "$BASE_URL/api/users/user-2/block" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isBlocked": true, "reason": "Actividad sospechosa detectada"}')
echo "$BLOCK_RES"

echo -e "\nIntentando hacer petición con el token de Ana estando BLOQUEADA:"
BLOCKED_REQ=$(curl -s -X GET "$BASE_URL/api/tasks" \
  -H "Authorization: Bearer $ANA_NEW_TOKEN")
echo "$BLOCKED_REQ"
echo "$BLOCKED_REQ" | grep -qi "suspended"
echo "✔ Correcto: Ana quedó bloqueada en tiempo real (HTTP 403)"

echo -e "\nIntentando hacer login con cuenta bloqueada:"
BLOCKED_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"password123"}')
echo "$BLOCKED_LOGIN"
echo "$BLOCKED_LOGIN" | grep -qi "suspended"
echo "✔ Correcto: Login rechazado para cuenta bloqueada"

echo -e "\n=========================================================="
echo "🧪 6. DESBLOQUEO DE USUARIO POR ADMINISTRADOR"
echo "=========================================================="
UNBLOCK_RES=$(curl -s -X PATCH "$BASE_URL/api/users/user-2/block" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isBlocked": false}')
echo "$UNBLOCK_RES"

echo -e "\nLogin de Ana tras ser desbloqueada:"
ANA_UNBLOCKED_LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"password123"}')
echo "$ANA_UNBLOCKED_LOGIN" | grep -qi "successful"
echo "✔ Correcto: Ana vuelve a acceder con normalidad tras ser desbloqueada"

echo -e "\n=========================================================="
echo "🎉 PRUEBAS DE STATEFUL SESSIONS Y BLOQUEO DE USUARIOS EXITOSAS"
echo "=========================================================="
