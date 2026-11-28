#!/usr/bin/env bash
# Runs ON the server: remove the old PM2-managed copy (/opt/babygrowth) and make the systemd service own port 3000.
set -uo pipefail
echo "==> PM2 apps before:"; pm2 list 2>/dev/null || true
for name in $(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const p of JSON.parse(s)){const e=p.pm2_env||{};const where=[e.pm_cwd,e.pm_exec_path,(e.args||[]).join(" ")].join(" ");if(/babygrowth|geogrowth|server[\\/]index\.js/i.test(where))console.log(p.name)}}catch{}})'); do
  echo "Deleting old PM2 app: $name"; pm2 delete "$name"
done
pm2 save 2>/dev/null || true
systemctl restart geogrowth
sleep 3
PORT=$(grep '^PORT=' /opt/geogrowth/.env | tail -1 | cut -d= -f2); PORT=${PORT:-3000}
owner=$(ss -ltnpH "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
echo "==> Port $PORT is owned by pid $owner: $(tr '\0' ' ' < /proc/$owner/cmdline 2>/dev/null)"
echo "==> Service: $(systemctl is-active geogrowth)"
if curl -fsS "http://127.0.0.1:$PORT/app.js" | grep -q openPromptDetail; then echo "NEW CODE LIVE"; else echo "STILL OLD CODE"; journalctl -u geogrowth -n 30 --no-pager; fi
