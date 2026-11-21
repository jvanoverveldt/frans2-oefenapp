import json, os, sys

with open("curriculum.json", encoding="utf-8") as f:
    d = json.load(f)

errs = []
ex = d.get("examen", {})
w = ex.get("weging", {})
if (
    w.get("schrijven") != 58
    or w.get("spreken_totaal") != 38
    or w.get("monoloog") != 8
    or w.get("gesprek") != 30
    or w.get("literatuurbeleving") != 4
):
    errs.append(f"Weging klopt niet: {w}")

crit = ex.get("beoordelingscriteria", [])
if len(crit) != 7:
    errs.append(f"Verwacht 7 beoordelingscriteria, gevonden: {len(crit)}")

doelen = d.get("communicatieve_doelen", [])
if len(doelen) != 6:
    errs.append(f"Verwacht 6 communicatieve doelen, gevonden: {len(doelen)}")

wf = d.get("woordvelden", [])
if len(wf) != 23:
    errs.append(f"Verwacht 23 woordvelden, gevonden: {len(wf)}")

for field in wf:
    n_w = len(field.get("woorden", []))
    n_v = len(field.get("voorbeelden", []))
    if n_w < 20:
        errs.append(f"{field.get('id')}: {n_w} woorden (verwacht >= 20)")
    if n_v < 3:
        errs.append(f"{field.get('id')}: {n_v} voorbeelden (verwacht >= 3)")
    for vb in field.get("voorbeelden", []):
        if vb.get("gat") not in vb.get("fr", ""):
            errs.append(f"{field.get('id')}: gat '{vb.get('gat')}' niet in '{vb.get('fr')}'")

gr = d.get("grammatica", [])
pijlers = {g.get("pijler") for g in gr}
expected = {"woordsoorten", "tijden_wijzen", "zinsbouw", "congruentie"}
if pijlers != expected:
    errs.append(f"Grammaticapijlers: {pijlers} != {expected}")

for g in gr:
    for o in g.get("onderdelen", []):
        vbs = o.get("voorbeelden", [])
        if len(vbs) != 2:
            errs.append(f"{o.get('id')}: {len(vbs)} voorbeelden (verwacht 2)")
        for vb in vbs:
            if vb.get("gat") not in vb.get("fr", ""):
                errs.append(f"{o.get('id')}: gat '{vb.get('gat')}' niet in '{vb.get('fr')}'")

if errs:
    print(f"FOUTEN ({len(errs)}):")
    for e in errs:
        print(" -", e)
    sys.exit(1)

sz = os.path.getsize("curriculum.json")
n_words = sum(len(x["woorden"]) for x in wf)
n_wf_vb = sum(len(x["voorbeelden"]) for x in wf)
n_gr = sum(len(g["onderdelen"]) for g in gr)
n_gr_vb = sum(len(o["voorbeelden"]) for g in gr for o in g["onderdelen"])
print(
    f"OK: {len(wf)} woordvelden ({n_words} kernwoorden, {n_wf_vb} voorbeeldzinnen), "
    f"{n_gr} grammatica-onderdelen ({n_gr_vb} voorbeeldzinnen), "
    f"{len(doelen)} doelen, {len(crit)} criteria, grootte={sz} bytes"
)
