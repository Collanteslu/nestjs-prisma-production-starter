#!/usr/bin/env bash
# Runs a built image the way production does and checks that it actually works:
#   - read-only root filesystem (+ tmpfs /tmp), no capabilities, no-new-privileges
#   - migrations apply, the seeded admin can log in, GET /healthz answers
#   - the image HEALTHCHECK reaches "healthy"
#
# Usage: scripts/docker-smoke.sh <image> [host-port]      (e.g. scripts/docker-smoke.sh nestjs-api:ci)
# DOCKER="sudo docker" scripts/docker-smoke.sh <image>    when docker needs sudo
set -euo pipefail

IMAGE="${1:?usage: scripts/docker-smoke.sh <image> [host-port]}"
HOST_PORT="${2:-3011}"
DOCKER="${DOCKER:-docker}"
NAME="api-smoke-$$"
VOLUME="${NAME}-data"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="Smoke-Passw0rd-12345"

cleanup() {
  $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
  $DOCKER volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "❌ $1" >&2
  echo "---- container logs ----" >&2
  $DOCKER logs "$NAME" >&2 2>&1 || true
  exit 1
}

# A fresh volume is root-owned: hand it to the image's non-root user before the real run
$DOCKER volume create "$VOLUME" >/dev/null
$DOCKER run --rm --user root -v "$VOLUME:/app/data" --entrypoint chown "$IMAGE" node:node /app/data

$DOCKER run -d --name "$NAME" \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$VOLUME:/app/data" \
  -p "127.0.0.1:$HOST_PORT:3011" \
  -e NODE_ENV=production \
  -e JWT_SECRET="smoke-jwt-secret-key-at-least-32-characters-long" \
  -e JWT_REFRESH_SECRET="smoke-jwt-refresh-secret-key-at-least-32-chars" \
  -e MFA_ENCRYPTION_KEY="smoke-mfa-encryption-key-at-least-32-characters" \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  "$IMAGE" >/dev/null

echo "⏳ Waiting for GET /healthz ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$HOST_PORT/healthz" >/dev/null 2>&1; then break; fi
  [ "$($DOCKER inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "the container exited during startup"
  sleep 1
done
curl -fsS "http://127.0.0.1:$HOST_PORT/healthz" >/dev/null 2>&1 || fail "GET /healthz did not answer within 60 s"
echo "✔ GET /healthz answers (read-only filesystem)"

LOGIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$HOST_PORT/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
[ "$LOGIN_STATUS" = "200" ] || fail "seeded admin login returned HTTP $LOGIN_STATUS (expected 200)"
echo "✔ The seeded production admin can sign in"

echo "⏳ Waiting for the image HEALTHCHECK to report healthy ..."
for _ in $(seq 1 24); do
  STATUS=$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")
  [ "$STATUS" = "healthy" ] && break
  [ "$STATUS" = "none" ] && fail "the image defines no HEALTHCHECK"
  sleep 5
done
[ "$STATUS" = "healthy" ] || fail "the HEALTHCHECK is '$STATUS' after 120 s"
echo "✔ HEALTHCHECK is healthy"

[ "$($DOCKER exec "$NAME" id -u)" != "0" ] || fail "the container runs as root"
echo "✔ Runs as a non-root user"
echo "✅ Docker smoke test passed for $IMAGE"
