---
name: curriculum-validator
description: >-
  Valideer curriculum.json op geldige JSON-syntaxis, exacte aantallen (23 woordvelden,
  4 grammaticapijlers, 6 communicatieve doelen, 7 beoordelingscriteria), weging en
  geldige gat-woorden voor offline invuloefeningen.
---

# Curriculum Validator

Gebruik deze skill na het aanmaken of bijwerken van `curriculum.json`.

## Validatiecommando

Voer onderstaand Python-commando uit in de projectmap:

```powershell
python -c "
import json, sys
with open('curriculum.json', encoding='utf-8') as f:
    d = json.load(f)
errs = []
ex = d.get('examen', {})
w = ex.get('weging', {})
if w.get('schrijven') != 58 or w.get('spreken_totaal') != 38 or w.get('monoloog') != 8 or w.get('gesprek') != 30 or w.get('literatuurbeleving') != 4:
    errs.append(f'Weging klopt niet: {w}')
crit = ex.get('beoordelingscriteria', [])
if len(crit) != 7:
    errs.append(f'Verwacht 7 beoordelingscriteria, gevonden: {len(crit)}')
doelen = d.get('communicatieve_doelen', [])
if len(doelen) != 6:
    errs.append(f'Verwacht 6 communicatieve doelen, gevonden: {len(doelen)}')
wf = d.get('woordvelden', [])
if len(wf) != 23:
    errs.append(f'Verwacht 23 woordvelden, gevonden: {len(wf)}')
for field in wf:
    n_w = len(field.get('woorden', []))
    n_v = len(field.get('voorbeelden', []))
    if not (15 <= n_w <= 25):
        errs.append(f\"{field.get('id')}: {n_w} woorden (verwacht ~20)\")
    if n_v != 3:
        errs.append(f\"{field.get('id')}: {n_v} voorbeelden (verwacht 3)\")
    for vb in field.get('voorbeelden', []):
        if vb.get('gat') not in vb.get('fr', ''):
            errs.append(f\"{field.get('id')}: gat '{vb.get('gat')}' niet in '{vb.get('fr')}'\")
gr = d.get('grammatica', [])
pijlers = {g.get('pijler') for g in gr}
expected = {'woordsoorten', 'tijden_wijzen', 'zinsbouw', 'congruentie'}
if pijlers != expected:
    errs.append(f'Grammaticapijlers: {pijlers} != {expected}')
for g in gr:
    for o in g.get('onderdelen', []):
        vbs = o.get('voorbeelden', [])
        if len(vbs) != 2:
            errs.append(f\"{o.get('id')}: {len(vbs)} voorbeelden (verwacht 2)\")
        for vb in vbs:
            if vb.get('gat') not in vb.get('fr', ''):
                errs.append(f\"{o.get('id')}: gat '{vb.get('gat')}' niet in '{vb.get('fr')}'\")
if errs:
    print('FOUTEN:', len(errs))
    for e in errs: print(' -', e)
    sys.exit(1)
print('OK:', len(wf), 'woordvelden,', sum(len(g['onderdelen']) for g in gr), 'grammatica-onderdelen,', len(doelen), 'doelen,', len(crit), 'criteria.')
"
```

## Kwaliteitscheck
- Alle Franse accenten (`é, è, ê, ë, à, â, ç, ù, û, ô, î, ï, œ`) zijn correct gespeld.
- Elk `gat`-woord komt exact (case-sensitive of exact substring) voor in de bijbehorende Franse voorbeeldzin `fr`.
- Bestandsgrootte blijft compact (< 150 KB).
