---
name: curriculum-validator
description: >-
  Valideer frans2_oefenapp/curriculum.json op geldige JSON-syntaxis, exacte aantallen
  (23 woordvelden, 4 grammaticapijlers, 6 communicatieve doelen, 7 beoordelingscriteria),
  weging en geldige gat-woorden voor offline invuloefeningen.
---

# Curriculum Validator

Gebruik deze skill na het aanmaken of bijwerken van `frans2_oefenapp/curriculum.json`.

## Validatiecommando

```powershell
python .agents/skills/curriculum-validator/scripts/validate.py
```

## Kwaliteitscheck
- Alle Franse accenten (`é, è, ê, ë, à, â, ç, ù, û, ô, î, ï, œ`) zijn correct gespeld.
- Elk `gat`-woord komt exact voor in de bijbehorende Franse voorbeeldzin `fr`.
- Alle 23 woordvelden (volledige *Kom maar op!*-woordenschat) en 17 grammatica-onderdelen zijn aanwezig.
