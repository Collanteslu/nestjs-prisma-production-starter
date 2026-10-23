#!/usr/bin/env bash
set -euo pipefail

# Batería VIVA de la colección Bruno (validación a fondo):
#   scripts/bruno-smoke.sh [baseUrl]     # por defecto http://127.0.0.1:3011
#
# Ejecuta los 36 ficheros de la colección contra un servidor en marcha con la CLI local
# (@usebruno/cli, fijada en devDependencies), en un ORDEN CONTROLADO y con tokens
# frescos por operación (revocar una sesión mata la que la creó), asertando el ESTADO
# HTTP de cada fichero vía --reporter-json (la CLI devuelve 0 aunque la respuesta falle,
# así que el estado es la única señal fiable).
#
# Clasificación de resultados esperados:
#   - Endpoints de entrada MANUAL devuelven 400/409 por diseño (tokens pegados,
#     códigos TOTP inventados, cuenta sin 2FA): se asertan como tales.
#   - Users/Delete se OMITE: es destructivo por diseño sobre los usuarios demo
#     (su contraparte soft-delete/restore ya está cubierto por el contrato en tasks/users).
#   - Register/Create aceptan 201 ó 409 (re-ejecuciones contra la misma BD).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRU="$ROOT/node_modules/.bin/bru"
BASE="${1:-http://127.0.0.1:3011}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bruno-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

[ -x "$BRU" ] || { echo "Falta la CLI: npm ci (devDependency @usebruno/cli)" >&2; exit 2; }
curl -sf "$BASE/healthz" >/dev/null || { echo "No hay servidor en $BASE (arráncalo en modo full con usuarios demo)" >&2; exit 2; }

PASS=0
FAIL=0
VARS=()

login() { # $1 email -> TOKEN/RT/SID (sesión nueva y fresca)
  local body
  body=$(curl -sf -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}") || { echo "login falló: $1" >&2; exit 1; }
  TOKEN=$(node -pe 'JSON.parse(process.argv[1]).accessToken' "$body")
  RT=$(node -pe 'JSON.parse(process.argv[1]).refreshToken' "$body")
  SID=$(node -pe 'JSON.parse(process.argv[1]).sessionId' "$body")
}

with_token()    { VARS=(--env-var "token=$1"); }
with_refresh()  { VARS=(--env-var "refreshToken=$1"); }
with_session()  { VARS=(--env-var "sessionId=$1" --env-var "token=$2"); }

check() { # $1 descripción, $2 estados aceptados (csv), $3.. fichero .bru
  local desc="$1" expected="$2"; shift 2
  local report="$WORK/report.json" got
  (cd "$ROOT/bruno" && "$BRU" run --env Local --env-var "baseUrl=$BASE" \
    "${VARS[@]}" --reporter-json "$report" "$@" >/dev/null 2>&1) || true
  got=$(node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const rs = (d[0] && d[0].results) || [];
      process.stdout.write(rs.map((x) => x.response ? x.response.status : "ERR").join(","));
    } catch { process.stdout.write("SIN-INFORME"); }
  ' "$report")
  if echo ",$expected," | grep -q ",$got,"; then
    PASS=$((PASS + 1)); printf '  ✓ %s (%s)\n' "$desc" "$got"
  else
    FAIL=$((FAIL + 1)); printf '  ✗ %s — esperado [%s], obtenido [%s]\n' "$desc" "$expected" "$got"
  fi
}

echo "== Bruno contra $BASE =="

# ---------------------------------------------------------------- Audit (admin)
login admin@example.com
with_token "$TOKEN"
check "Audit: listado" 200 "Audit/List Audit Logs.bru"

# ---------------------------------------------------------------- Sessions (usuario)
# Sesión fresca por operación: cada revocación mata la sesión que la ejecuta
login ana@example.com; with_session "$SID" "$TOKEN"
check "Sessions: mis sesiones" 200 "Sessions/My Sessions.bru"
login ana@example.com; with_session "$SID" "$TOKEN"
check "Sessions: revocar una sesión" 200 "Sessions/Revoke Session.bru"
login ana@example.com; with_session "$SID" "$TOKEN"
check "Sessions: revocar todas" 200 "Sessions/Revoke All Sessions.bru"

# ---------------------------------------------------------------- Tasks (admin)
login admin@example.com; with_token "$TOKEN"
check "Tasks: listado" 200 "Tasks/List Tasks.bru"
check "Tasks: crear" 201,409 "Tasks/Create Task.bru"
check "Tasks: obtener task-1" 200 "Tasks/Get Task By ID.bru"
check "Tasks: actualizar task-1" 200 "Tasks/Update Task.bru"
check "Tasks: borrado lógico de task-1" 200 "Tasks/Delete Task.bru"
check "Tasks: restaurar task-1" 200 "Tasks/Restore Task.bru"

# ---------------------------------------------------------------- Users (admin)
login admin@example.com; with_token "$TOKEN"
check "Users: listado" 200 "Users/List Users.bru"
check "Users: obtener user-1" 200 "Users/Get User By ID.bru"
check "Users: crear usuario" 201,409 "Users/Create User.bru"
check "Users: actualizar user-2" 200 "Users/Update User.bru"
check "Users: suspender user-2" 200 "Users/Block User (Admin).bru"
check "Users: reactivar user-2" 200 "Users/Unblock User (Admin).bru"
check "Users: revocar sesiones de user-2" 200 "Users/Revoke User Sessions.bru"
check "Users: cambiar rol de user-2" 200 "Users/Change User Role (Admin).bru"
check "Users: reset 2FA sin 2FA → 409 documentado" 409 "Users/Reset User MFA (Admin).bru"
# Users/Delete OMITIDO (destructivo sobre los usuarios demo; la semántica soft-delete
# ya está cubierta por el contrato de tasks/users)
echo "  - Users/Delete User omitido a propósito (destructivo sobre los usuarios demo)"

# El update renombró a Ana: restaurar el nombre original de la semilla
curl -sf -X PUT "$BASE/api/users/user-2" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Ana García"}' >/dev/null \
  && echo "  ✓ nombre de user-2 restaurado a 'Ana García'" \
  || { FAIL=$((FAIL + 1)); echo "  ✗ no se pudo restaurar el nombre de user-2"; }

# ---------------------------------------------------------------- Auth (públicos y manuales)
login ana@example.com; with_refresh "$RT"
check "Auth: refresh (rotación)" 200 "Auth/Refresh Token.bru"
check "Auth: registro" 201,409 "Auth/Register.bru"
check "Auth: forgot-password → 202" 202 "Auth/Forgot Password.bru"
check "Auth: resend-verification → 202" 202 "Auth/Resend Verification.bru"
check "Auth: reset con token pegado → 400 (manual)" 400 "Auth/Reset Password.bru"
check "Auth: verify con token pegado → 400 (manual)" 400 "Auth/Verify Email.bru"

login admin@example.com; with_token "$TOKEN"
check "Auth: MFA setup (deja alta pendiente)" 200 "Auth/MFA Setup.bru"
check "Auth: MFA enable con código inventado → 400 (manual)" 400 "Auth/MFA Enable.bru"
check "Auth: MFA disable sin 2FA activo → 409" 409 "Auth/MFA Disable.bru"

login ana@example.com; with_refresh "$RT"
check "Auth: logout" 200 "Auth/Logout.bru"

echo
echo "Bruno: $PASS conformes, $FAIL inesperados"
[ "$FAIL" -eq 0 ] || exit 1
