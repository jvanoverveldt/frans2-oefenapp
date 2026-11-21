# Changelog

## 1.0.1

- `python3` expliciet geïnstalleerd in de Alpine-container (`apk add --no-cache python3 openssl`) zodat de add-on ook op Home Assistant's standaard base image direct opstart.
- `DATA_DIR` expliciet geëxporteerd in `run.sh` voor s6-overlay compatibiliteit.

## 1.0.0

- Eerste volledige release als Home Assistant Add-on met Ingress-ondersteuning.
- Volledige leerstof Frans 2 (B1): 23 woordvelden (2.190 woorden), 17 grammatica-onderdelen, Schrijven (58%) en Spreken & Gesprek (38%).
- Persistente opslag in `/data` (`progress.json` en `config.json`).
- Optionele lokale HTTPS-listener op poort `8443` (met automatisch zelf-ondertekend certificaat of eigen `/ssl/`-certificaten) voor directe microfoonopname in de browser.
