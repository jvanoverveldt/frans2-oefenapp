# Frans 2 Oefenapp (Examencommissie B1)

Lokale oefenapp en Home Assistant Add-on voor **Frans 2 (2de graad doorstroomfinaliteit, niveau B1 — Vlaamse Examencommissie)**.

Gebouwd in pure HTML5, CSS3, Vanilla ES6 JavaScript en een compacte Python 3 stdlib-server (zonder externe packages of frameworks).

## Lokaal starten (Windows / macOS / Linux)

```bash
python server.py
```

Open daarna `http://localhost:8099`. Voortgang en instellingen worden automatisch opgeslagen in `./data/` (genegeerd door Git).

## Installeren op Home Assistant

### Optie A — Via GitHub Custom Repository (aanbevolen)

1. Push deze repository naar GitHub (pas eventueel `url` in `repository.yaml` aan naar jouw GitHub-repo).
2. Open in Home Assistant: **Instellingen → Add-ons → Add-on Store → ⋮ (rechtsboven) → Repositories**.
3. Voeg de GitHub-URL van deze repository toe en vernieuw de Store.
4. Installeer **Frans 2 Oefenapp (B1)**, vul optioneel je `gemini_api_key` in onder **Configuratie** en start de add-on.
5. Zet **Weergeven in zijbalk** aan om de app direct via Ingress te openen.

### Optie B — Lokaal op Home Assistant (zonder GitHub)

1. Kopieer enkel de map `frans2_oefenapp/` naar `/addons/frans2_oefenapp` op je Home Assistant (via Samba of SSH).
2. Open **Instellingen → Add-ons → Add-on Store → ⋮ → Controleren op updates**.
3. Installeer onder **Lokale add-ons** de add-on **Frans 2 Oefenapp (B1)**.

### Microfoon bij Spreken & Gesprek op een lokaal netwerk

Als Home Assistant enkel via HTTP (`http://homeassistant.local:8123`) bereikbaar is, blokkeert de browser de microfoon in Ingress. De add-on start daarom automatisch ook een beveiligde lokale HTTPS-poort op `8443` (`https://homeassistant.local:8443` of je ingestelde `https_hostname` / IP). Accepteer eenmalig het lokale certificaat in je browser; de Tab **Spreken & Gesprek** toont hiervoor ook automatisch een directe link wanneer de app via HTTP geopend wordt.

## Projectstructuur

- `frans2_oefenapp/` — Enige bron van waarheid voor zowel Home Assistant als lokaal gebruik (`server.py`, `index.html`, `style.css`, `app.js`, `curriculum.json`, `config.yaml`, `Dockerfile`, `build.yaml`, `run.sh`, `DOCS.md`, `CHANGELOG.md`).
- `server.py` — Kleine wrapper in de root zodat `python server.py` lokaal blijft werken met `./data/`.
- `repository.yaml` — Metadata voor de Home Assistant Custom Add-on Store.
