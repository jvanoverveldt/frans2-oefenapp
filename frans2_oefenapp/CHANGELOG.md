# Changelog

## 1.0.3

- Directe HTTP-poort (`8099/tcp`) nu ook rechtstreeks bereikbaar op het thuisnetwerk zonder Home Assistant-login (`http://homeassistant.local:8099`).
- Automatische HTTP → HTTPS redirect (301) op poort `8443` wanneer een browser per ongeluk `http://` i.p.v. `https://` opent (voorkomt `ERR_EMPTY_RESPONSE`).
- Interne TLS self-test bij opstarten gelogd in het tabblad Log.

## 1.0.2

- HTTPS-server verbeterd met per-verbinding TLS-handshake (`TLSThreadingHTTPServer`) en duidelijke TLS-logging zodat afgebroken browser-handshakes andere verbindingen nooit blokkeren.
- Zelf-ondertekend lokaal certificaat bijgewerkt naar 800 dagen met X.509 v3 `serverAuth`-extensies voor betere compatibiliteit met Chrome, Edge, Safari, iOS en Android.

## 1.0.1

- `python3` expliciet geïnstalleerd in de Alpine-container (`apk add --no-cache python3 openssl`) zodat de add-on ook op Home Assistant's standaard base image direct opstart.
- `DATA_DIR` expliciet geëxporteerd in `run.sh` voor s6-overlay compatibiliteit.

## 1.0.0

- Eerste volledige release als Home Assistant Add-on met Ingress-ondersteuning.
- Volledige leerstof Frans 2 (B1): 23 woordvelden (2.190 woorden), 17 grammatica-onderdelen, Schrijven (58%) en Spreken & Gesprek (38%).
- Persistente opslag in `/data` (`progress.json` en `config.json`).
- Optionele lokale HTTPS-listener op poort `8443` (met automatisch zelf-ondertekend certificaat of eigen `/ssl/`-certificaten) voor directe microfoonopname in de browser.
