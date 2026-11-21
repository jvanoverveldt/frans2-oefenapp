# Frans 2 Oefenapp (B1 — Examencommissie)

Interactieve oefenapp voor **Frans 2 (2de graad doorstroomfinaliteit, niveau B1)** van de Vlaamse Examencommissie.

## Onderdelen

- **Overzicht:** Gewogen examenvoortgang (Schrijven 58%, Gesprek 30%, Monoloog 8%) en taalbasis (Woordenschat & Grammatica).
- **Woordenschat:** Alle 23 woordvelden (2.190 kernwoorden) met actief vertalen NL → FR, 3-staps Leitner-herhaling, invuloefeningen en zinsbouw.
- **Grammatica:** Alle 17 grammatica-onderdelen (4 pijlers) met zichtbare regels, AI-coach (6 B1-oefentypes), verplichte herstelstap en leerkracht-paneel.
- **Schrijven (58%):** Schrijven, Schriftelijke interactie en Strikte Examensimulatie (90 min) met 7-criteria feedback, herschrijfstap en Schrijfarchief.
- **Spreken & Gesprek (38%):** Monoloog (8%) en interactief Gesprek (30%, oefen- en strikte examenmodus) met audio-opname, transcript en Spreekarchief.

## Configuratie

| Optie | Standaard | Uitleg |
| --- | --- | --- |
| `gemini_api_key` | *(leeg)* | Je Google AI Studio API-key (kan ook in de app bij *Instellingen* ingevuld worden). |
| `gemini_model` | `gemini-3.5-flash-lite` | Gebruikt Gemini-model. |
| `enable_https` | `true` | Start een extra lokale HTTPS-poort (`8443`) voor directe microfoonopname. |
| `https_hostname` | `homeassistant.local` | Hostnaam of lokaal IP-adres van je Home Assistant (bv. `192.168.1.50`). |
| `use_ha_ssl` | `false` | Zet op `true` als je al eigen certificaten in `/ssl/` hebt (bv. Let's Encrypt). |
| `certfile` / `keyfile` | `fullchain.pem` / `privkey.pem` | Bestandsnamen in `/ssl/` wanneer `use_ha_ssl: true`. |

## Microfoon gebruiken op een lokaal HTTP-netwerk

Browsers blokkeren microfoonopname op `http://`-adressen (zoals Home Assistant Ingress op `http://homeassistant.local:8123`).

- **Dagelijks oefenen (Woordenschat, Grammatica, Schrijven):** Open gewoon **Frans 2** via de Home Assistant-zijbalk (Ingress).
- **Directe microfoonopname (Spreken & Gesprek):** Open `https://homeassistant.local:8443` (of `https://<ip-van-home-assistant>:8443`). De eerste keer toont je browser een melding over het zelf-ondertekende lokale certificaat — klik op *Geavanceerd → Doorgaan*. Daarna werkt de microfoon rechtstreeks!
- **Alternatief zonder HTTPS:** Op elke tablet/smartphone werkt *Audio uploaden* en tekstinvoer ook gewoon via HTTP.

## Opslag & Back-ups

Alle voortgang (`progress.json`), eigen leerkracht-oefeningen, schrijf-/spreekarchieven en instellingen worden automatisch opgeslagen in `/data` en mee opgenomen in standaard Home Assistant-backups.
