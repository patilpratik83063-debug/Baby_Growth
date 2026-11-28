#!/usr/bin/env bash
# Runs ON the server. Installs/updates GeoGrowth as a systemd service.
# Layout:  /opt/geogrowth/app   (code, replaced each deploy)
#          /opt/geogrowth/data  (SQLite DB + secret key, kept across deploys)
#          /opt/geogrowth/.env  (config, kept across deploys)
set -euo pipefail
ROOT=/opt/geogrowth
STAGE="$1"                     # unpacked bundle
PUBLIC_URL="${2:-}"
cd "$STAGE"

echo "==> Node.js"
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 24 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  echo "Node 24+ not found; installing Node 24 from NodeSource"
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
    (command -v dnf >/dev/null && dnf install -y nodejs) || yum install -y nodejs
  else
    echo "Install Node.js 24+ manually, then re-run." >&2; exit 1
  fi
fi
NODE_BIN=$(command -v node)
echo "node $($NODE_BIN -v) at $NODE_BIN"

mkdir -p "$ROOT/data"

echo "==> Config"
if [ ! -f "$ROOT/.env" ]; then
  cp "$STAGE/.env" "$ROOT/.env"
  echo "Installed .env from this deploy"
else
  echo "Keeping existing $ROOT/.env"
  # add the OpenRouter key if the server's config lacks it
  if ! grep -q '^OPENROUTER_API_KEY=.\+' "$ROOT/.env" && grep -q '^OPENROUTER_API_KEY=' "$STAGE/.env"; then
    grep '^OPENROUTER_API_KEY=' "$STAGE/.env" >> "$ROOT/.env"; echo "Added OPENROUTER_API_KEY"
  fi
fi
rm -f "$STAGE/.env"
if [ -n "$PUBLIC_URL" ]; then
  sed -i '/^PUBLIC_BASE_URL=/d' "$ROOT/.env"; echo "PUBLIC_BASE_URL=$PUBLIC_URL" >> "$ROOT/.env"
fi
sed -i '/^DATA_DIR=/d' "$ROOT/.env"; echo "DATA_DIR=$ROOT/data" >> "$ROOT/.env"
chmod 600 "$ROOT/.env"
if grep -q '^AUTH_FIXED_CODE=.\+' "$ROOT/.env"; then
  echo "WARNING: AUTH_FIXED_CODE is set in $ROOT/.env. Anyone who knows that code can sign in to ANY account. Remove it on a public server."
fi
PORT=$(grep '^PORT=' "$ROOT/.env" | tail -1 | cut -d= -f2); PORT=${PORT:-3000}

echo "==> Existing data"
if [ ! -f "$ROOT/data/geogrowth.db" ]; then
  old=$(find / -xdev -name geogrowth.db -path '*/data/*' -not -path "$ROOT/*" -not -path '/proc/*' 2>/dev/null | head -1 || true)
  if [ -n "$old" ]; then
    echo "Found previous database at $old; copying it (with WAL and secret key) into $ROOT/data"
    dir=$(dirname "$old")
    cp -a "$dir"/geogrowth.db* "$ROOT/data/" 2>/dev/null || true
    [ -f "$dir/secret.key" ] && cp -a "$dir/secret.key" "$ROOT/data/"
  else
    echo "No previous database found; starting fresh"
  fi
fi

echo "==> Stop any old copy on port $PORT"
systemctl stop geogrowth 2>/dev/null || true
if command -v pm2 >/dev/null; then
  # match on working dir and args too: apps started with "npm start" have npm as their exec path
  for name in $(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const p of JSON.parse(s)){const e=p.pm2_env||{};const where=[e.pm_cwd,e.pm_exec_path,(e.args||[]).join(" ")].join(" ");if(/babygrowth|geogrowth|server[\\/]index\.js|server\.js/i.test(where))console.log(p.name)}}catch{}})'); do
    echo "Removing pm2 app $name"; pm2 delete "$name" || true
  done
  pm2 save 2>/dev/null || true
fi
for pid in $(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  if tr '\0' ' ' < /proc/$pid/cmdline | grep -qE 'server/index\.js|server\.js'; then echo "Stopping old node server pid $pid"; kill "$pid" || true; fi
done
sleep 1

echo "==> Install app"
rm -rf "$ROOT/app.new"; mv "$STAGE" "$ROOT/app.new"
cd "$ROOT/app.new" && npm ci --omit=dev --no-audit --no-fund
rm -rf "$ROOT/app.prev"; [ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.prev"
mv "$ROOT/app.new" "$ROOT/app"

cat > /etc/systemd/system/geogrowth.service <<UNIT
[Unit]
Description=GeoGrowth
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$ROOT/app
ExecStart=$NODE_BIN --env-file=$ROOT/.env server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now geogrowth
systemctl restart geogrowth

echo "==> Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT"/tcp >/dev/null && echo "ufw: opened $PORT"; fi

echo "==> Health check"
for i in $(seq 1 20); do
  if out=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
    # make sure the port belongs to the new service, not a respawned old copy
    owner=$(ss -ltnpH "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    if [ "$owner" = "$(systemctl show -p MainPID --value geogrowth)" ]; then echo "$out"; echo "DEPLOY OK: http://$(hostname -I | awk '{print $1}'):$PORT"; exit 0; fi
    echo "Port $PORT is held by another process ($(tr '\0' ' ' < /proc/$owner/cmdline 2>/dev/null)); not the new service."; break
  fi
  sleep 1
done
echo "Server did not become healthy. Last logs:"; journalctl -u geogrowth -n 40 --no-pager; exit 1
