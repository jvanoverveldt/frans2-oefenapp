# Project Rules — Frans 2 Oefenapp (Examencommissie B1)

- **Bron van waarheid:** Gebruik uitsluitend `frans2_oefenapp/curriculum.json`. Lees of verwijs nooit opnieuw naar PDF-bestanden (`*.pdf` staat in `.gitignore`).
- **Single Source of Truth:** Alle runtime-bestanden staan in `frans2_oefenapp/` (`server.py`, `index.html`, `style.css`, `app.js`, `curriculum.json`, plus Home Assistant Add-on bestanden). Root `server.py` is enkel een dunne launcher voor lokaal gebruik met `./data/`.
- **Stack:** Pure HTML5, CSS3, Vanilla ES6 JavaScript en een kleine Python 3 stdlib-server (`frans2_oefenapp/server.py`, geen pip-packages, frameworks, bundlers of `node_modules`).
- **Home Assistant Ingress-ready:** Gebruik overal uitsluitend relatieve paden (`./style.css`, `./app.js`, `./curriculum.json`, `./api/progress`), nooit root-absolute paden (`/curriculum.json`).
- **Privacy & opslag:** Persoonlijke voortgang en API-config staan in `data/` (`data/` staat in `.gitignore`; op Home Assistant via `DATA_DIR=/data`).
- **Token-budget (API):** Standaardmodel `gemini-3.5-flash-lite` (aanpasbaar in Instellingen en HA-opties). Stuur per Gemini API-call enkel strikt noodzakelijke context (max. ~1.500 tokens: gekozen thema/doel + compacte rubric, nooit de hele `curriculum.json`).
- **Codekwaliteit:** Modulair, beknopt, geen onnodige comments of dummy-bestanden. Schrijfvelden voor examenoefeningen gebruiken `spellcheck="false"`.
- **Git-discipline:** Ontwikkel gradueel per fase en maak na elke geteste mijlpaal een duidelijke commit.
