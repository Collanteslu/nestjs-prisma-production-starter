#!/usr/bin/env bash
set -euo pipefail

# Ensayo de runbooks en un entorno AISLADO (BDs scratch en tmpdir, puertos 3913/3914,
# nada toca dev.db ni las BDs de paridad). Ningún procedimiento de AGENTS.md se da por
# validado hasta pasar aquí:
#
#   scripts/ops-rehearsal.sh mfa-rotation     # rotación de clave MFA con versiones
#   scripts/ops-rehearsal.sh backup-restore   # backup cifrado + restauración probada
#
# Sale con código != 0 y el log del servidor en $WORK si algo falla (el trap lo limpia).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ops-rehearsal.XXXXXX")"
MODE="${1:-}"

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFALLO:\033[0m %s\n' "$*" >&2; [ -f "$WORK/server.log" ] && tail -30 "$WORK/server.log" >&2; exit 1; }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

prisma_cli() { node "$ROOT/node_modules/prisma/build/index.js" "$@"; }

start_server() { # $1=puerto $2=db $3..=env extra
  local port="$1" db="$2"; shift 2
  env PORT="$port" AUTH_MODE=full DATABASE_URL="file:$db" \
    JWT_SECRET="rehearsal-secret-0123456789abcdef0123456789" \
    JWT_REFRESH_SECRET="rehearsal-refresh-abcdef0123456789abcdef01" \
    MAIL_TRANSPORT=log APP_URL="http://127.0.0.1:$port" \
    "$@" node "$ROOT/dist/main.js" >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  local i
  for i in $(seq 1 30); do
    curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || fail "el servidor no arrancó"
    sleep 1
  done
  fail "timeout de healthz en :$port"
}

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

# Generador TOTP (RFC 6238, mismos parámetros que la app) para la prueba
write_totp_helper() {
  cat >"$WORK/totp.mjs" <<'EOF'
import { createHmac } from "node:crypto";
const secret = process.argv[2];
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = 0, value = 0;
const bytes = [];
for (const ch of secret.toUpperCase()) {
  const idx = A.indexOf(ch);
  if (idx < 0) continue;
  value = (value << 5) | idx; bits += 5;
  while (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
}
const counter = Math.floor(Date.now() / 1000 / 30);
const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
const hmac = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
const off = hmac[hmac.length - 1] & 0xf;
const code = (((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1e6;
process.stdout.write(String(code).padStart(6, "0"));
EOF
}
totp() { node "$WORK/totp.mjs" "$1"; }

# Espera al siguiente paso TOTP de 30 s: el anti-replay rechaza repetir un paso ya
# consumido (enable y cada login reclaman el suyo), y las fases ocurren en segundos.
wait_next_totp_step() { sleep $(( 30 - ($(date +%s) % 30) + 1 )); }

json_field() { # $1=json $2=campo (respuesta plana)
  node -e 'const d=JSON.parse(process.argv[1]); const v=process.argv[2].split(".").reduce((a,k)=>a?.[k], d); if(v===undefined||v===null){process.exit(1)}; process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"
}

require_build() {
  [ -f "$ROOT/dist/main.js" ] || (cd "$ROOT" && npm run build >/dev/null)
}

# ------------------------------------------------------------------ mfa-rotation
mfa_rotation() {
  require_build
  write_totp_helper
  local db="$WORK/mfa-rotation.db"
  local key1="rehearsal-key1-0123456789abcdef0123456789ab"
  local key2="rehearsal-key2-fedcba9876543210fedcba9876543210"
  local base="http://127.0.0.1:3913"
  local email="rotation-$(date +%s)@example.com"

  log "Fase A: servidor con la clave MFA actual (K1) — enrolamiento TOTP"
  (cd "$ROOT" && DATABASE_URL="file:$db" prisma_cli migrate deploy >/dev/null)
  start_server 3913 "$db" MFA_ENCRYPTION_KEY="$key1"
  local login secret code enable setup login_body
  curl -sf -X POST "$base/api/auth/register" -H 'content-type: application/json' \
    -d "{\"name\":\"Rotation\",\"email\":\"$email\",\"password\":\"Password123!\"}" >/dev/null \
    || fail "register (fase A)"
  login=$(curl -s -X POST "$base/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Password123!\"}") || fail "login (fase A)"
  local token
  token=$(json_field "$login" accessToken) || fail "accessToken (fase A)"
  setup=$(curl -s -X POST "$base/api/auth/mfa/setup" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -d '{"currentPassword":"Password123!"}') || fail "mfa/setup"
  secret=$(json_field "$setup" data.secret) || fail "secret del setup: $setup"
  code=$(totp "$secret")
  enable=$(curl -s -X POST "$base/api/auth/mfa/enable" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -d "{\"code\":\"$code\"}") || fail "mfa/enable"
  json_field "$enable" "data.recoveryCodes.0" >/dev/null || fail "sin códigos de recuperación: $enable"
  echo "✓ 2FA enrolado con K1 (secret emitido, enable aceptó el código)"
  wait_next_totp_step
  stop_server

  log "Fase B: rotación — K2 vigente + K1 como anterior (descifrado con la anterior)"
  start_server 3913 "$db" MFA_ENCRYPTION_KEY="$key2" MFA_ENCRYPTION_KEY_PREVIOUS="$key1"
  code=$(totp "$secret")
  login_body=$(curl -s -X POST "$base/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Password123!\",\"totpCode\":\"$code\"}")
  echo "$login_body" | grep -q '"accessToken"' || fail "login TOTP tras rotar: $login_body"
  echo "✓ El login con TOTP funciona con la clave anterior configurada (descifrado con K1)"
  wait_next_totp_step
  stop_server

  log "Fase C: solo K2 — prueba de que el re-cifrado perezoso ya ocurrió"
  start_server 3913 "$db" MFA_ENCRYPTION_KEY="$key2"
  code=$(totp "$secret")
  login_body=$(curl -s -X POST "$base/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Password123!\",\"totpCode\":\"$code\"}")
  echo "$login_body" | grep -q '"accessToken"' || fail "login TOTP solo con K2 (¿no se re-cifró?): $login_body"
  echo "✓ El secreto ya está cifrado con K2: rotación completa sin perder a ningún usuario"
  stop_server
}

# ------------------------------------------------------------------ backup-restore
backup_restore() {
  require_build
  local src="$WORK/live.db"
  local restored="$WORK/restored/live.db"
  local password="rehearsal-backup-pass"
  mkdir -p "$WORK/restored"

  log "Fase A: datos vivos en una BD scratch (3914)"
  (cd "$ROOT" && DATABASE_URL="file:$src" prisma_cli migrate deploy >/dev/null)
  start_server 3914 "$src" MFA_ENCRYPTION_KEY="rehearsal-key-0123456789abcdef0123456789ab"
  local email="backup-$(date +%s)@example.com"
  curl -sf -X POST "http://127.0.0.1:3914/api/auth/register" -H 'content-type: application/json' \
    -d "{\"name\":\"Backup\",\"email\":\"$email\",\"password\":\"Password123!\"}" >/dev/null \
    || fail "register (fase A)"
  stop_server

  log "Fase B: snapshot consistente (VACUUM INTO) + CIFRADO AES-256-CBC/PBKDF2"
  # Copiar el .db a secas perdería lo que aún vive en el -wal (¡el ensayo lo demostró!):
  # VACUUM INTO produce una instantánea consistente en un único fichero, WAL incluido.
  node -e '
    const { createClient } = require("@libsql/client");
    const [url, out] = process.argv.slice(1);
    createClient({ url }).execute("VACUUM INTO \x27" + out + "\x27").catch((e) => { console.error(e.message); process.exit(1); });
  ' "file:$src" "$WORK/snapshot.db" || fail "VACUUM INTO (snapshot)"
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$password" \
    -in "$WORK/snapshot.db" -out "$WORK/backup.db.enc" || fail "openssl al cifrar"
  [ -s "$WORK/backup.db.enc" ] || fail "backup vacío"
  rm -f "$src" "$WORK/snapshot.db" # solo queda el backup cifrado
  echo "✓ backup.db.enc generado (instantánea consistente) y orígenes eliminados"

  log "Fase C: restauración en otra ruta (entorno aislado)"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$password" \
    -in "$WORK/backup.db.enc" -out "$restored" || fail "openssl al descifrar"
  (cd "$ROOT" && DATABASE_URL="file:$restored" prisma_cli migrate diff \
    --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code) \
    || fail "migrate diff tras restaurar"
  echo "✓ esquema coherente con prisma/migrations"

  log "Fase D: arranque contra lo restaurado + verificación de datos + contrato"
  start_server 3914 "$restored" MFA_ENCRYPTION_KEY="rehearsal-key-0123456789abcdef0123456789ab"
  local login
  login=$(curl -s -X POST "http://127.0.0.1:3914/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Password123!\"}")
  echo "$login" | grep -q '"accessToken"' || fail "el usuario del backup no existe tras restaurar: $login"
  echo "✓ los datos sobrevivieron (login del usuario creado antes del backup)"
  (cd "$ROOT" && node contract/run.mjs --base "http://127.0.0.1:3914" --mode full --db "$restored" --group system) \
    || fail "grupo system del contrato sobre lo restaurado"
  echo "✓ contrato system en verde contra la restauración"
  stop_server
}

case "$MODE" in
  mfa-rotation) mfa_rotation ;;
  backup-restore) backup_restore ;;
  *)
    echo "Uso: scripts/ops-rehearsal.sh mfa-rotation|backup-restore" >&2
    exit 2
    ;;
esac

log "ENSAYO OK: $MODE"
