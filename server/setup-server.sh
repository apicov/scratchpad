#!/bin/bash
# One-time server setup for Fedora (needs root): joins the tailnet and runs the scratchpad server on
# the Tailscale IP only. Run it from your copy of the repo on the server:
#   sudo bash server/setup-server.sh                 (server runs as the user who called sudo)
#   sudo APP_USER=someone bash server/setup-server.sh
set -euo pipefail
APP_USER=${APP_USER:-${SUDO_USER:?run with sudo, or set APP_USER}}
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)

dnf install -y tailscale
systemctl enable --now tailscaled
tailscale ip -4 >/dev/null 2>&1 || tailscale up   # prints a login URL: open it and approve
TS_IP=$(tailscale ip -4)

# Allow tailnet traffic in; the public interface (eth0) stays as it is
firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
firewall-cmd --reload

cat > /etc/systemd/system/pico-scratchpad.service <<EOF
[Unit]
Description=Pico Scratchpad (tailnet only)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=$APP_USER
Environment=HOST=$TS_IP PORT=8787 DATA_DIR=/home/$APP_USER/scratchpad-data
ExecStart=/usr/bin/node $APP_DIR/server/server.js
# Retries until the Tailscale IP exists after boot
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now pico-scratchpad
sleep 1
systemctl --no-pager status pico-scratchpad | head -5
echo "✅ Scratchpad: http://$TS_IP:8787"
