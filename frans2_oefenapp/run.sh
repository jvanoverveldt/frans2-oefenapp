#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"
OPTIONS_FILE="${DATA_DIR}/options.json"

eval "$(python3 - "$OPTIONS_FILE" <<'PY'
import ipaddress, json, os, shlex, sys

opts = {}
path = sys.argv[1]
if os.path.isfile(path):
    try:
        with open(path, encoding="utf-8") as fh:
            opts = json.load(fh)
    except Exception:
        opts = {}

enable_https = bool(opts.get("enable_https", False))
use_ha_ssl = bool(opts.get("use_ha_ssl", False))
hostname = str(opts.get("https_hostname") or "homeassistant.local").strip() or "homeassistant.local"
certfile = str(opts.get("certfile") or "fullchain.pem").strip()
keyfile = str(opts.get("keyfile") or "privkey.pem").strip()

san_parts = ["DNS:localhost", "IP:127.0.0.1"]
try:
    ipaddress.ip_address(hostname)
    san_parts.insert(0, f"IP:{hostname}")
except ValueError:
    san_parts.insert(0, f"DNS:{hostname}")

print(f"ENABLE_HTTPS={'true' if enable_https else 'false'}")
print(f"USE_HA_SSL={'true' if use_ha_ssl else 'false'}")
print(f"HTTPS_HOSTNAME={shlex.quote(hostname)}")
print(f"HA_CERTFILE={shlex.quote(certfile)}")
print(f"HA_KEYFILE={shlex.quote(keyfile)}")
print(f"SSL_SAN={shlex.quote(','.join(san_parts))}")
PY
)"

export ENABLE_HTTPS HTTPS_HOSTNAME

if [ "$ENABLE_HTTPS" = "true" ]; then
    if [ "$USE_HA_SSL" = "true" ]; then
        export SSL_CERTFILE="/ssl/${HA_CERTFILE}"
        export SSL_KEYFILE="/ssl/${HA_KEYFILE}"
    else
        SSL_DIR="${DATA_DIR}/ssl"
        CERT_PATH="${SSL_DIR}/cert.pem"
        KEY_PATH="${SSL_DIR}/key.pem"
        HOST_STAMP="${SSL_DIR}/hostname.txt"
        mkdir -p "$SSL_DIR"

        CURRENT_HOST=""
        if [ -f "$HOST_STAMP" ]; then
            CURRENT_HOST="$(cat "$HOST_STAMP")"
        fi

        if [ ! -f "$CERT_PATH" ] || [ ! -f "$KEY_PATH" ] || [ "$CURRENT_HOST" != "$HTTPS_HOSTNAME" ]; then
            echo "[frans2] Zelf-ondertekend lokaal HTTPS-certificaat genereren voor ${HTTPS_HOSTNAME}..."
            openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
                -keyout "$KEY_PATH" \
                -out "$CERT_PATH" \
                -subj "/CN=${HTTPS_HOSTNAME}" \
                -addext "subjectAltName=${SSL_SAN}" >/dev/null 2>&1
            chmod 600 "$KEY_PATH"
            printf '%s' "$HTTPS_HOSTNAME" > "$HOST_STAMP"
        fi

        export SSL_CERTFILE="$CERT_PATH"
        export SSL_KEYFILE="$KEY_PATH"
    fi
fi

exec python3 /app/server.py
