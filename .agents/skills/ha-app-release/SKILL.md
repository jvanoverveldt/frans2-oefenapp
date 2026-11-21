---
name: ha-app-release
description: >-
  Checklist en release-stappen om een nieuwe versie van de Frans 2 Home Assistant Add-on
  (frans2_oefenapp/) te valideren, versie te bumpen, changelog bij te werken en uit te rollen.
---

# Home Assistant Add-on Release

Gebruik deze skill telkens wanneer je een nieuwe versie van `frans2_oefenapp/` wilt uitbrengen voor Home Assistant.

## 1. Technische validatie

Voer deze controles uit vanuit de repository-root:

```powershell
python .agents/skills/curriculum-validator/scripts/validate.py
node --check frans2_oefenapp/app.js
python -m py_compile frans2_oefenapp/server.py server.py
```

Controleer daarnaast:
- **Geen root-absolute paden** in `frans2_oefenapp/index.html` of `frans2_oefenapp/app.js` (alle assets en API-calls starten met `./`).
- **LF regeleindes** (`\n`, geen `\r\n`) in `frans2_oefenapp/run.sh`.
- **Geen persoonlijke data of PDF's** gestaged in Git (`git status --short` mag nooit `data/` of `*.pdf` tonen).

## 2. Versie verhogen & Changelog

Home Assistant Supervisor detecteert een update enkel wanneer `version` in `frans2_oefenapp/config.yaml` verhoogd is (SemVer, bv. `1.0.0` → `1.0.1` of `1.1.0`):

1. Verhoog `version:` in `frans2_oefenapp/config.yaml`.
2. Voeg bovenaan `frans2_oefenapp/CHANGELOG.md` een korte sectie toe met het nieuwe versienummer en de wijzigingen.
3. Controleer of eventuele nieuwe bestanden in `frans2_oefenapp/` ook in de `COPY`-regel van `frans2_oefenapp/Dockerfile` staan.

## 3. Lokaal testen & uitrollen

1. Start lokaal met `python server.py` en verifieer `/` en `/api/health`.
2. Commit en push naar GitHub (`git push`).
3. Ga in Home Assistant naar **Instellingen → Add-ons → Add-on Store → ⋮ → Controleren op updates** en klik bij **Frans 2 Oefenapp (B1)** op **Bijwerken**.
