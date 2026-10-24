#!/usr/bin/env python3
"""Typical home recipes for everyday Indian dishes, valued from their ingredients.

USDA's own entries for these dishes describe a different food: its "Upma" is
made with Cream of Wheat, its "Idli" with split peas, its "Chutney" is mango
jam. So each dish here is one typical home batch, written down in
data/typical/ as raw ingredients in grams, the weight the batch comes out at,
and its servings. INDB's textbook recipes (Jaacks et al., 2024) are the source
of the proportions where INDB has the dish; the rest are everyday home versions
marked "no source". INDB's own figures are never read: they count the whole
frying oil as eaten, and they are per 100 g of raw ingredients, not of the dish.

Nothing is summed here. A typical recipe ships as its lines, and the app values
a portion the way it values a portion of one of your own recipes: each
ingredient's share of the batch, at that ingredient's USDA values, so an
ingredient with no value adds nothing and keeps its weight counted as
unmeasured. Water lines are listed for what the recipe assumes and never
valued; the cooked weight is where the water is accounted for.

Run on its own, this checks the two files and prints each dish's figures:
    python3 tools/typical_dishes.py
"""
from __future__ import annotations

import csv
import hashlib
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "data", "typical")

DATA_TYPE = "typical_recipe"
SOURCE = "TR"
ID_RANGE = (100_000_001, 199_999_999)
ROLES = {"food", "water", "no data"}
USDA_TYPES = {"sr_legacy_food", "foundation_food", "survey_fndds_food"}
ENERGY = 1008
# Per 100 g of the dish. Outside this, a weight or a gram figure was mistyped.
ENERGY_RANGE = (10.0, 650.0)


def _read(name):
    with open(os.path.join(DIR, name), newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _num(text, where):
    try:
        v = float((text or "").strip())
    except ValueError:
        sys.exit(f"{where}: {text!r} is not a number")
    if v <= 0:
        sys.exit(f"{where}: {text!r} must be positive")
    return v


def _portion(text, where):
    """'1 bowl=200' -> ('1 bowl', 200.0)."""
    label, _, grams = text.partition("=")
    if not label.strip():
        sys.exit(f"{where}: {text!r} is not 'name=grams'")
    return label.strip(), _num(grams, where)


def load():
    """The two files, checked for shape. What they name is checked by `problems`."""
    dishes, seen, last = [], set(), 0
    for i, r in enumerate(_read("dishes.csv"), start=2):
        where = f"dishes.csv row {i}"
        did = int(_num(r["id"], where))
        # shortcut: catches a copied or misordered id, not one reused after its
        # dish was deleted; a deleted dish's id stays retired.
        if not ID_RANGE[0] <= did <= ID_RANGE[1] or did <= last:
            sys.exit(f"{where}: id {did} must be in {ID_RANGE} and after {last}")
        last = did
        name = r["name"].strip()
        if not name or name.lower() in seen:
            sys.exit(f"{where}: name {name!r} is empty or used twice")
        seen.add(name.lower())
        piece = _portion(r["piece"], where) if r["piece"].strip() else None
        servings = [_portion(s, where) for s in r["servings"].split(";") if s.strip()]
        if not piece and not servings:
            sys.exit(f"{where}: {name} needs a piece or a serving")
        dishes.append({
            "id": did,
            "name": name,
            "aliases": [a.strip().lower() for a in r["aliases"].split(";") if a.strip()],
            "group": r["group"].strip(),
            "cooked_g": _num(r["cooked_g"], where),
            "piece": piece,
            "servings": servings,
            "source": r["source"].strip() or "no source",
            "replaces": [int(_num(x, where)) for x in r["replaces"].split(";") if x.strip()],
            "note": r["note"].strip(),
            "lines": [],
        })
    by_id = {d["id"]: d for d in dishes}
    for i, r in enumerate(_read("ingredients.csv"), start=2):
        where = f"ingredients.csv row {i}"
        dish = by_id.get(int(_num(r["dish_id"], where)))
        if dish is None:
            sys.exit(f"{where}: no dish {r['dish_id']}")
        role = r["role"].strip()
        fdc = int(_num(r["fdc_id"], where)) if r["fdc_id"].strip() else None
        if role not in ROLES or (fdc is None) != (role != "food"):
            sys.exit(f"{where}: role {role!r} with fdc_id {fdc}; a food line names a "
                     "USDA food, a water or no-data line names none")
        dish["lines"].append({
            "ingredient": r["ingredient"].strip(),
            "fdc_id": fdc,
            "raw_g": _num(r["raw_g"], where),
            "role": role,
            "note": r["note"].strip(),
        })
    for d in dishes:
        if not any(l["role"] == "food" for l in d["lines"]):
            sys.exit(f"{d['name']} has no ingredient with values")
    return dishes


def digest():
    """SHA-256 of the two files. The app compares it with its own copy of the
    database, so a phone holding one built from older recipes replaces it."""
    h = hashlib.sha256()
    for name in ("dishes.csv", "ingredients.csv"):
        with open(os.path.join(DIR, name), "rb") as f:
            h.update(f.read())
    return h.hexdigest()


def per_100g(dish, value, nutrient_id):
    """(at least so much per 100 g, share of the batch that had a value).

    The app's own sum for a portion of a recipe, for checking: water lines are
    not part of it, and a line with no value adds nothing but its weight.
    `value(fdc_id, nutrient_id)` gives food_nutrients' (kind, amount) or None.
    """
    lower = mass = covered = 0.0
    for l in dish["lines"]:
        if l["role"] == "water":
            continue
        mass += l["raw_g"]
        v = value(l["fdc_id"], nutrient_id) if l["fdc_id"] else None
        if v and v[0] in ("measured", "measured_zero", "assumed_zero"):
            covered += l["raw_g"]
            lower += (v[1] or 0.0) * l["raw_g"] / 100.0
    return lower / dish["cooked_g"] * 100.0, covered / mass


def problems(dishes, value, data_types):
    """What would ship wrong, each as a sentence for verify()."""
    found = []
    for d in dishes:
        name = d["name"]
        for l in d["lines"]:
            if l["fdc_id"] is not None and data_types.get(l["fdc_id"]) not in USDA_TYPES:
                found.append(f"{name}: {l['ingredient']} names {l['fdc_id']}, not a USDA food here")
        for r in d["replaces"]:
            if data_types.get(r) not in USDA_TYPES:
                found.append(f"{name} replaces {r}, not a USDA food here")
        # The batch cannot weigh less than the dry matter that went into it.
        solids = 0.0
        for l in d["lines"]:
            if l["role"] == "water":
                continue
            w = value(l["fdc_id"], 1051) if l["fdc_id"] else None
            solids += l["raw_g"] * (1 - (w[1] or 0.0) / 100.0 if w and w[0] == "measured" else 1)
        if d["cooked_g"] < solids:
            found.append(f"{name} comes out at {d['cooked_g']:g} g, less than the "
                         f"{solids:.0f} g of solids that went in")
        energy, _ = per_100g(d, value, ENERGY)
        if not ENERGY_RANGE[0] <= energy <= ENERGY_RANGE[1]:
            found.append(f"{name}: {energy:.0f} kcal in 100 g is outside {ENERGY_RANGE}")
    return found


def rows(dishes):
    """Every table's rows for the reference database."""
    t = {k: [] for k in ("foods", "food_portions", "food_aliases",
                         "food_recipes", "food_recipe_lines", "food_replaced")}
    for d in dishes:
        did = d["id"]
        t["foods"].append((did, d["name"], DATA_TYPE, SOURCE, None))
        piece = [(f"1 {d['piece'][0]}", d["piece"][1])] if d["piece"] else []
        for label, grams in piece + d["servings"]:
            t["food_portions"].append((did, 1.0, None, label, grams, SOURCE))
        for a in d["aliases"]:
            t["food_aliases"].append((a, did, None))
        noun, each = d["piece"] or (None, None)
        t["food_recipes"].append((did, d["cooked_g"], noun, each, d["source"], d["note"]))
        for seq, l in enumerate(d["lines"]):
            t["food_recipe_lines"].append(
                (did, seq, l["ingredient"], l["fdc_id"], l["raw_g"], l["role"], l["note"] or None))
        for r in d["replaces"]:
            t["food_replaced"].append((r, did))
    return t


SCHEMA = """
-- A typical home recipe's batch: what it comes out at, what one piece of it
-- weighs, and where its proportions came from. It has no food_nutrients rows:
-- a portion is valued from food_recipe_lines, as a portion of a recipe is.
CREATE TABLE food_recipes (
  fdc_id     INTEGER PRIMARY KEY REFERENCES foods(fdc_id),
  cooked_g   REAL NOT NULL CHECK (cooked_g > 0),
  piece_noun TEXT,
  piece_g    REAL CHECK (piece_g IS NULL OR piece_g > 0),
  source     TEXT NOT NULL,
  note       TEXT NOT NULL,
  CHECK ((piece_noun IS NULL) = (piece_g IS NULL))
);
-- What the recipe assumes, line by line. Only a 'food' line is valued.
CREATE TABLE food_recipe_lines (
  fdc_id     INTEGER NOT NULL REFERENCES food_recipes(fdc_id),
  seq        INTEGER NOT NULL,
  ingredient TEXT NOT NULL,
  ingredient_fdc_id INTEGER REFERENCES foods(fdc_id),
  raw_g      REAL NOT NULL CHECK (raw_g > 0),
  role       TEXT NOT NULL CHECK (role IN ('food','water','no data')),
  note       TEXT,
  PRIMARY KEY (fdc_id, seq),
  CHECK ((ingredient_fdc_id IS NOT NULL) = (role = 'food'))
) WITHOUT ROWID;
-- A USDA entry for the same dish, which search and quick-add stop offering.
CREATE TABLE food_replaced (
  fdc_id    INTEGER PRIMARY KEY REFERENCES foods(fdc_id),
  by_fdc_id INTEGER NOT NULL REFERENCES food_recipes(fdc_id)
);
"""


def _report(db_path):
    """Check the files against a built reference database and print the figures."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    vals = {(f, n): (k, a) for f, n, k, a in con.execute(
        "SELECT fdc_id, nutrient_id, value_kind, amount FROM food_nutrients")}
    types = dict(con.execute("SELECT fdc_id, data_type FROM foods"))
    value = lambda f, n: vals.get((f, n))
    dishes = load()
    for p in problems(dishes, value, types):
        print(f"! {p}")
    for d in dishes:
        label, grams = (f"1 {d['piece'][0]}", d["piece"][1]) if d["piece"] else d["servings"][0]

        def fig(nid, unit):
            per100, share = per_100g(d, value, nid)
            return f"{'' if share >= 1 else '≥'}{per100 * grams / 100:.0f} {unit}"

        print(f"{d['name']}: {label} ({grams:g} g) {fig(1008, 'kcal')}, protein {fig(1003, 'g')}, "
              f"fat {fig(1004, 'g')}, carbs {fig(1005, 'g')}, fibre {fig(1079, 'g')}, "
              f"sodium {fig(1093, 'mg')}")


if __name__ == "__main__":
    _report(os.path.join(ROOT, "src-tauri", "resources", "usda_core.db"))
