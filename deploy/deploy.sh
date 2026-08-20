#!/bin/bash
# =============================================================
# Deploy script - Run on the Lightsail server
# Pulls latest code from GitHub and restarts the app
# =============================================================

set -e

APP_DIR="/opt/mandamail"
REPO_URL="https://github.com/manda4web/mandamail.git"
BRANCH="main"

echo "=== Deploying email-bitrix-app ==="

# Clone or pull
if [ -d "$APP_DIR/.git" ]; then
  echo "Pulling latest changes..."
  cd "$APP_DIR"
  git pull origin "$BRANCH"
else
  echo "Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# Check if .env exists
if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "ERROR: .env file not found!"
  echo "Copy .env.example to .env and fill in your values:"
  echo "  cp .env.example .env"
  echo "  nano .env"
  echo ""
  exit 1
fi

# Build and start — minimal downtime window:
# 1. build the image while the OLD container is still serving
# 2. `up -d app` recreates ONLY the app container (postgres/redis keep
#    running; a full `down` would needlessly restart the database)
echo "Building image (app still serving)..."
docker compose build app

echo "Recreating app container..."
docker compose up -d --remove-orphans app

echo ""
echo "=== Deploy complete! ==="
echo "App running at: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):3000"
echo ""
echo "Check logs: docker compose logs -f app"
echo "Check status: docker compose ps"
