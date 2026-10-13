#!/usr/bin/env bash
# pm2 entry point for Bancha, in the same style as ~/Arak/deploy/start.sh.
# Register once:  pm2 start ~/ControlPane_Bancha/deploy/start.sh --name bancha --exp-backoff-restart-delay=3000 && pm2 save
# Deploy:         cd ~/ControlPane_Bancha && git pull origin main && pm2 restart bancha
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# Secrets live only in .env on this host (gitignored). Refuse to start without it.
if [[ ! -f .env ]]; then
  echo "[bancha] $APP_DIR/.env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi
set -a; source ./.env; set +a

# Reinstall dependencies only when the lockfile changed since the last install.
STAMP=node_modules/.lock-sha
SHA="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d node_modules || "$(cat "$STAMP" 2>/dev/null)" != "$SHA" ]]; then
  echo "[bancha] installing dependencies"
  npm ci --omit=dev --no-audit --no-fund
  echo "$SHA" > "$STAMP"
fi

exec node server/server.js
