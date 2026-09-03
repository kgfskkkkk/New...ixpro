#!/bin/bash
# FlareSolverr setup — free Cloudflare solver on http://localhost:8191
# Miruro's Cloudflare blocks datacenter IPs. FlareSolverr runs a real browser
# (undetected Chromium) and solves the "Just a moment" JS challenge.
# Run this ON YOUR VPS (needs Docker). Safe to re-run.

set -u

echo "==> Checking Docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker not found — installing (docker.io)..."
  apt-get update -y
  apt-get install -y docker.io || { echo "Docker install failed."; exit 1; }
fi

if ! docker info >/dev/null 2>&1; then
  echo "==> Starting Docker daemon..."
  (systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true)
  sleep 5
fi

echo "==> (Re)starting FlareSolverr container (127.0.0.1:8191)..."
docker rm -f flaresolverr >/dev/null 2>&1 || true
docker run -d \
  --name flaresolverr \
  --restart unless-stopped \
  -p 127.0.0.1:8191:8191 \
  -e LOG_LEVEL=info \
  ghcr.io/flaresolverr/flaresolverr:latest

echo "==> Waiting for FlareSolverr to boot..."
UP=0
for i in $(seq 1 40); do
  if curl -s -m 3 http://localhost:8191/ >/dev/null 2>&1; then
    UP=1
    echo "==> FlareSolverr is up: http://localhost:8191"
    break
  fi
  sleep 2
done

if [ "$UP" != "1" ]; then
  echo "!! FlareSolverr did not come up. Check logs: docker logs flaresolverr"
  exit 1
fi

echo ""
echo "Done. Add these to the miruro-api environment (miruro-api/.env or your"
echo "hosting dashboard):"
echo ""
echo "  CF_SOLVER_URL=http://localhost:8191"
echo "  CF_SOLVER_MODE=flaresolverr"
echo ""
echo "Then restart the bot so the anime API picks up the change."
