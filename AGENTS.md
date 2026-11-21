# Project Rules — Frans 2 Oefenapp (Examencommissie B1)

- **Bron van waarheid:** Gebruik uitsluitend `curriculum.json`. Lees of verwijs nooit opnieuw naar PDF-bestanden (`*.pdf` staat in `.gitignore`).
- **Stack:** Pure HTML5, CSS3 en Vanilla ES6 JavaScript. Geen frameworks, bundlers of `node_modules`.
- **Home Assistant Ingress-ready:** Gebruik overal uitsluitend relatieve paden (`./style.css`, `./app.js`, `./curriculum.json`), nooit root-absolute paden (`/curriculum.json`).
- **Token-budget (API):** Standaardmodel `gemini-3.5-flash-lite` (aanpasbaar in Instellingen). Stuur per Gemini API-call enkel strikt noodzakelijke context (max. ~1.500 tokens: gekozen thema/doel + compacte rubric, nooit de hele `curriculum.json`).
- **Codekwaliteit:** Modulair, beknopt, geen onnodige comments of dummy-bestanden. Schrijfvelden voor examenoefeningen gebruiken `spellcheck="false"`.
- **Git-discipline:** Ontwikkel gradueel per fase en maak na elke geteste mijlpaal een duidelijke commit.
