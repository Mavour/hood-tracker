#!/usr/bin/env bash
# Share the already-open public port 4000:
#   http://IP:4000/      → Reminder Samsat
#   http://IP:4000/hood  → hood-tracker
set -euo pipefail

ROOT="${HOME}/rh/hood-tracker"
cd "$ROOT"
git pull

export NEXT_BASE_PATH=/hood
export NEXT_PUBLIC_BASE_PATH=/hood
npm run build

echo ">> Move reminder-samsat off :4000 onto :4001 (internal)"
PORT=4001 pm2 restart reminder-samsat --update-env
sleep 2

if ss -tlnp | grep -E ':4000\b' | grep -vq nginx; then
  echo "ERROR: something is still bound to :4000 (need it free for nginx):"
  ss -tlnp | grep -E ':4000\b' || true
  echo "Set reminder-samsat to listen on 4001, then re-run this script."
  exit 1
fi

echo ">> Start hood-tracker on 127.0.0.1:8080 (not public)"
pm2 delete hood-tracker >/dev/null 2>&1 || true
PORT=8080 NEXT_BASE_PATH=/hood NEXT_PUBLIC_BASE_PATH=/hood \
  pm2 start ecosystem.config.cjs --only hood-tracker --update-env

echo ">> nginx on public :4000"
sudo apt-get install -y nginx
sudo cp "$ROOT/deploy/nginx-4000.conf" /etc/nginx/sites-available/hood-on-4000
sudo ln -sfn /etc/nginx/sites-available/hood-on-4000 /etc/nginx/sites-enabled/hood-on-4000
sudo nginx -t
sudo systemctl reload nginx
pm2 save

echo
echo "Samsat:        http://$(curl -4 -s ifconfig.me):4000/"
echo "Hood tracker:  http://$(curl -4 -s ifconfig.me):4000/hood/nft"
