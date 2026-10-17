#!/bin/bash
# GCP Compute Engine Startup Script (Debian / Ubuntu)
# Deploys Dronacharya on a VM directly without Docker
set -euo pipefail

echo "==> [Dronacharya GCP Setup] Initializing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential

# Install Node.js 22 LTS
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
  echo "==> [Dronacharya GCP Setup] Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> [Dronacharya GCP Setup] Node version: $(node -v), npm version: $(npm -v)"

APP_DIR="/opt/dronacharya"
mkdir -p "$APP_DIR"

# If the code was synced or cloned to APP_DIR
if [ -f "$APP_DIR/package.json" ]; then
  cd "$APP_DIR"
  echo "==> [Dronacharya GCP Setup] Installing npm dependencies..."
  npm install

  echo "==> [Dronacharya GCP Setup] Building frontend bundle..."
  npm run build:frontend

  # Setup systemd service if provided
  if [ -f "$APP_DIR/deploy/gcp/dronacharya.service" ]; then
    cp "$APP_DIR/deploy/gcp/dronacharya.service" /etc/systemd/system/dronacharya.service
    systemctl daemon-reload
    systemctl enable dronacharya
    systemctl restart dronacharya
    echo "==> [Dronacharya GCP Setup] Dronacharya service active and running!"
  fi
fi

echo "==> [Dronacharya GCP Setup] Complete."
