#!/usr/bin/env bash
set -e

# ============================================================================
# SCRIPT KHỞI CHẠY NHANH CỔNG KẾT NỐI INTERNET (NGROK / CLOUDFLARE TUNNEL)
# Tự động đọc cấu hình từ file .env của dự án Backend
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

PORT="${PORT:-3000}"
PROVIDER="${PUBLIC_TUNNEL_PROVIDER:-NGROK}"
DOMAIN="${NGROK_DOMAIN:-}"

# Chuẩn hóa tên miền nếu người dùng nhập kèm https://
CLEAN_DOMAIN="$(echo "$DOMAIN" | sed -E 's#^https?://##' | sed -E 's#/.*$##')"

echo "=================================================================="
echo " PANCAKE SELLER OS — PUBLIC TUNNEL GATEWAY ($PROVIDER)"
echo " Target Backend Local Port : http://localhost:$PORT"
echo " Webhook Endpoint Pattern  : /api/webhooks/omnichannel/{channel}"
echo "=================================================================="

if [ "$PROVIDER" = "CLOUDFLARE_TUNNEL" ]; then
  echo "[INFO] Starting Cloudflare Tunnel -> http://localhost:$PORT ..."
  exec cloudflared tunnel --url "http://localhost:$PORT"
fi

if [ -n "$NGROK_AUTHTOKEN" ]; then
  ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1 || true
fi

if [ -n "$CLEAN_DOMAIN" ]; then
  echo "[INFO] Starting Ngrok with static domain: https://$CLEAN_DOMAIN -> http://localhost:$PORT"
  exec ngrok http "$PORT" --url="https://$CLEAN_DOMAIN"
else
  echo "[INFO] Starting Ngrok with dynamic domain (Backend will auto-detect via 127.0.0.1:4040)..."
  exec ngrok http "$PORT"
fi
