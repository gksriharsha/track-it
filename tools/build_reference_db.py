#!/usr/bin/env python3
"""Build the bundled read-only USDA reference database for TrackIt.

Reads the extracted USDA bulk CSVs under data/raw/extracted/ and produces
src-tauri/resources/usda_core.db, the read-only reference database shipped
inside the app. (See OUT_DB below for why it is written there and not under
data/.)

The design rules this implements are in docs/decisions.md; the measurements that
justify them are in docs/data-findings.md. Three of them are load-bearing here:

  D11  FNDDS `food_nutrient.nutrient_id` holds legacy `nutrient_nbr` values, not FDC
       ids. The ranges do not overlap, so a naive join silently drops all 353k FNDDS
       rows. We translate, and assert the join actually matched.

  D1   Portions keep `amount` and `gram_weight` as separate columns. FNDDS leaves
       `amount` blank on every row; deriving grams-per-unit would divide by nothing,
       and on SR Legacy it would silently rewrite what the label means.

  D2   A nutrient value is a tagged union, never a nullable float. "Absent" is
       represented by the absence of a row and is never stored as 0.

Run:  python3 tools/build_reference_db.py
"""

from __future__ import annotations

import csv
import os
import sqlite3
import sys
from collections import Counter, defaultdict

csv.field_size_limit(10**9)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRACTED = os.path.join(ROOT, "data", "raw", "extracted")
# Written inside src-tauri deliberately. Tauri maps a resource declared as
# "../data/x" into the Android assets directory as "_up_/data/x", and AGP's
# DEFAULT ignoreAssetsPattern contains "<dir>_*" — it silently drops any asset
# directory whose name begins with an underscore. The file vanishes from the APK
# with no warning and the app then cannot find its database. Keeping the path
# free of ".." avoids the whole trap.
OUT_DB = os.path.join(ROOT, "src-tauri", "resources", "usda_core.db")

DATASETS = {
    "FF": ("FoodData_Central_foundation_food_csv_2026-04-30", "foundation_food"),
    "SR": ("FoodData_Central_sr_legacy_food_csv_2018-04", "sr_legacy_food"),
    "FN": ("FoodData_Central_survey_food_csv_2024-10-31", "survey_fndds_food"),
}
IODINE_XLSX = os.path.join(
    EXTRACTED, "iodine", "Iodine Database_Release 4_Per 100g.xlsx"
)

# --- nutrient classification -------------------------------------------------
#
# role     'primary'   renders as a dashboard row
#          'component' a constituent of a primary (folic acid within folate)
#          'alternate' a competing measurement of a primary (energy 2047 vs 1008)
#          'ul_source' read only by the upper-limit evaluator, never displayed
#
# Only 'primary' is displayed. Without this, folate renders four times and vitamin A
# six times as sibling rows, each with its own bar and %RDA (docs/decisions.md D8).

# The nutrients the dashboard actually displays, in order, grouped.
# Everything else in FDC's 477-row dictionary is still INGESTED (so it is
# available for resolution chains and future features) but is not a dashboard
# row. Without this the panel renders 477 rows including individual catechins,
# rare fatty acid isomers and sugars like triose and tetrose.
DISPLAY = [
    ("Energy & macros", [
        (1008, "core"), (1003, "core"), (1004, "core"), (1005, "core"),
        (1079, "core"), (2000, "core"), (1235, "extended"),
    ]),
    ("Fats", [
        (1258, "core"), (1292, "core"), (1293, "core"), (1257, "extended"),
        (1253, "core"), (1404, "core"), (1316, "core"), (1272, "core"), (1278, "core"),
    ]),
    ("Vitamins", [
        (1106, "core"), (1162, "core"), (1114, "core"), (1109, "core"), (1185, "core"),
        (1165, "core"), (1166, "core"), (1167, "core"), (1170, "core"), (1175, "core"),
        (1176, "extended"), (1190, "core"), (1178, "core"), (1180, "core"),
    ]),
    ("Minerals", [
        (1087, "core"), (1089, "core"), (1090, "core"), (1091, "core"), (1092, "core"),
        (1093, "core"), (1095, "core"), (1098, "core"), (1101, "core"), (1103, "core"),
        (1100, "extended"), (1096, "extended"), (1102, "extended"), (1099, "extended"),
    ]),
    ("Other", [
        (1051, "core"), (1057, "core"), (1018, "core"),
    ]),
]

# FDC's own names are laboratory names ("Fatty acids, total saturated", "PUFA
# 18:3 n-3 c,c,c (ALA)"). They truncate badly in a phone-width row, so the
# dashboard uses a short label and keeps the full name for the tooltip.
SHORT_NAMES = {
    1008: "Energy", 1003: "Protein", 1004: "Fat", 1005: "Carbs",
    1079: "Fiber", 2000: "Sugars", 1235: "Added sugars",
    1258: "Saturated", 1292: "Monounsaturated", 1293: "Polyunsaturated",
    1257: "Trans fat", 1253: "Cholesterol",
    1404: "Omega-3 (ALA)", 1316: "Omega-6 (LA)", 1272: "DHA", 1278: "EPA",
    1106: "Vitamin A", 1162: "Vitamin C", 1114: "Vitamin D", 1109: "Vitamin E",
    1185: "Vitamin K", 1165: "Thiamin (B1)", 1166: "Riboflavin (B2)",
    1167: "Niacin (B3)", 1170: "Pantothenic acid (B5)", 1175: "Vitamin B6",
    1176: "Biotin (B7)", 1190: "Folate", 1178: "Vitamin B12", 1180: "Choline",
    1087: "Calcium", 1089: "Iron", 1090: "Magnesium", 1091: "Phosphorus",
    1092: "Potassium", 1093: "Sodium", 1095: "Zinc", 1098: "Copper",
    1101: "Manganese", 1103: "Selenium", 1100: "Iodine", 1096: "Chromium",
    1102: "Molybdenum", 1099: "Fluoride",
    1051: "Water", 1057: "Caffeine", 1018: "Alcohol",
}

# Flattened: nutrient_id -> (group, order, tier)
DISPLAY_MAP = {}
for _gi, (_group, _items) in enumerate(DISPLAY):
    for _oi, (_nid, _tier) in enumerate(_items):
        DISPLAY_MAP[_nid] = (_group, _gi * 100 + _oi, _tier)

# Nutrients read by machinery rather than shown: UL evaluation, or an alternate
# measurement of something already displayed. Kept out of the dashboard so
# folate does not render four times and vitamin A six times.
NON_DISPLAY_ROLES = {
    # alternates in a resolution chain
    2047: "alternate", 2048: "alternate", 1062: "alternate",   # energy
    1050: "alternate",                                          # carbohydrate by summation
    2033: "alternate",                                          # fiber AOAC 2011.25
    1063: "alternate",                                          # sugars NLEA
    1104: "alternate",                                          # vitamin A IU
    1110: "alternate",                                          # vitamin D IU
    1169: "alternate",                                          # niacin equivalent
    1270: "alternate", 1269: "alternate",                       # undifferentiated 18:3 / 18:2
    # components of a displayed total
    1177: "component", 1187: "component",                       # folate total / food folate
    1107: "component", 1108: "component", 1120: "component",    # carotenes
    # read only by the upper-limit evaluator
    1186: "ul_source",                                          # folic acid  (folate UL)
    1105: "ul_source",                                          # retinol     (vitamin A UL)
    1245: "ul_source",                                          # added niacin (niacin UL)
}

# `basis` distinguishes ug RAE from ug retinol from ug DFE, and mg alpha-
# tocopherol from mg niacin-equivalent, so arithmetic between incompatible
# bases can be rejected instead of silently producing a number.
BASIS = {
    1106: "rae", 1105: "retinol", 1104: "iu_a",
    1190: "dfe", 1186: "folic_acid", 1177: "mass", 1187: "mass",
    1109: "alpha_te", 1169: "ne",
    1114: "mass", 1110: "iu_d",
    1008: "energy", 1062: "energy", 2047: "energy", 2048: "energy",
}
MAGNITUDE_FIX = {"KCAL": "kcal", "KJ": "kJ", "IU": "IU", "G": "g", "MG": "mg", "UG": "ug"}

# Derivation codes that make a zero meaningful rather than merely unexplained.
#   Z  = assumed zero: USDA asserts the nutrient is genuinely absent.
#   A* = analytical:   a lab measured and found nothing above its detection limit.
# A zero with blank derivation carries no such assertion and is NOT treated as covered.
ASSUMED_ZERO_CODES = {"Z"}
ANALYTICAL_PREFIXES = ("A",)
CALCULATED_CODES = {"NC", "AS", "MC"}


# --- Indian-name synonym layer -------------------------------------------------
#
# Most Indian vegetarian staples are ALREADY in USDA — under names an Indian cook
# would never search for. Urad dal is filed as "Mungo beans" (Vigna mungo);
# drumstick/moringa as "Drumstick leaves"; rava as "Semolina". Searching the
# Indian name returns nothing, which reads as "this food is missing" when it is
# merely differently labelled.
#
# An alias points at a food that IS the thing searched for. It must never
# silently redirect to a different food that merely resembles it — that is the
# same class of error as rendering missing data as zero.
#
# Ghee is the cautionary case. Traditional ghee, especially the bilona method,
# cultures milk into curd, churns it to makkhan, and simmers that until the milk
# solids brown before straining. Clarified butter skips the culturing and the
# browning; "butter oil, anhydrous" is an industrial concentrate of cream that
# never goes through the ghee process at all. They are not the same product.
#
# USDA compounds this: it has no independently measured ghee. Its "Ghee,
# clarified butter" entry (2710168) is 85% value-identical to butter oil across
# the 60 nutrients they share, because it is derived from that profile rather
# than measured. So "ghee" points at the entry actually NAMED ghee, and carries
# a note saying the numbers are an anhydrous-milk-fat proxy.
#
# Every id here is asserted to exist at build time.
ALIASES = {
    174259: ["urad dal raw", "black gram raw", "ulundu", "minapappu", "vigna mungo"],
    172427: ["urad dal", "black gram", "urad", "ulundu paruppu", "minapappu cooked"],
    174256: ["moong dal raw", "mung bean raw", "green gram raw", "pesarapappu"],
    174257: ["moong dal", "mung bean", "green gram", "moong", "pesalu"],
    172436: ["toor dal raw", "arhar dal raw", "tuvar raw", "kandi pappu raw"],
    172437: ["toor dal", "arhar dal", "tuvar dal", "pigeon pea", "kandi pappu"],
    173756: ["kabuli chana raw", "chhole raw", "bengal gram raw", "safed chana"],
    173757: ["chana", "chhole", "kabuli chana", "bengal gram", "chickpea"],
    172420: ["masoor raw", "brown lentil raw", "sabut masoor"],
    172421: ["masoor dal", "masoor", "lentil dal", "dal"],
    174284: ["masoor dal raw", "red lentil", "pink lentil", "lal masoor"],
    175193: ["rajma raw", "kidney bean raw", "lal lobia"],
    173740: ["rajma", "kidney bean", "red kidney bean"],
    173758: ["lobia raw", "chawli raw", "black eyed pea raw"],
    173759: ["lobia", "chawli", "black eyed pea", "cowpea", "alasandalu"],
    174288: ["besan", "gram flour", "chickpea flour", "senagapindi"],
    168893: ["atta", "whole wheat flour", "gehun ka atta", "chapati flour", "godhuma pindi"],
    168933: ["rava", "sooji", "suji", "semolina", "bombay rava", "upma rava"],
    172023: ["bajra", "pearl millet", "sajjalu", "kambu"],
    168943: ["jowar", "sorghum", "jonnalu", "cholam"],
    170682: ["rajgira", "amaranth grain", "ramdana"],
    168877: ["chawal", "basmati", "white rice", "biyyam", "arisi"],
    2710168: ["ghee", "tup", "neyyi", "nei", "desi ghee", "bilona ghee"],
    173412: ["clarified butter", "anhydrous milk fat", "butter oil"],
    171284: ["dahi", "curd", "yogurt", "perugu", "thayir"],
    171265: ["doodh", "milk", "paalu", "paal"],
    168462: ["palak", "spinach", "paalakura", "keerai"],
    168416: ["drumstick leaves raw", "moringa raw", "munagaku raw"],
    168417: ["drumstick leaves", "moringa", "sahjan", "munagaku", "murungai keerai"],
    169260: ["bhindi", "okra", "lady finger", "bendakaya", "vendakkai"],
    169228: ["baingan", "brinjal", "eggplant", "aubergine", "vankaya", "kathirikai"],
    169232: ["lauki", "bottle gourd", "doodhi", "sorakaya", "calabash"],
    168394: ["karela", "bitter gourd", "bitter melon", "kakarakaya", "pavakkai"],
    168385: ["chaulai", "amaranth leaves", "thotakura", "arai keerai"],
    169256: ["sarson ka saag", "mustard greens", "sarson greens"],
    170000: ["pyaz", "onion", "kanda", "ullipaya", "vengayam"],
    170457: ["tamatar", "tomato", "takkali"],
    169230: ["lehsun", "garlic", "vellulli", "poondu"],
    169231: ["adrak", "ginger", "allam", "inji"],
    172231: ["haldi", "turmeric", "pasupu", "manjal"],
    171319: ["lal mirch", "chilli powder", "red chilli", "karam"],
    170923: ["jeera", "cumin", "zeera", "jilakarra"],
    170922: ["dhania", "coriander seed", "dhaniya"],
    170929: ["rai", "mustard seed", "sarson seed", "aavalu", "kadugu"],
    171324: ["methi", "fenugreek", "menthulu", "vendhayam"],
    167763: ["imli", "tamarind", "chinta pandu", "puli"],
    170169: ["nariyal", "coconut", "kobbari", "thengai"],
    173468: ["namak", "salt", "uppu"],
    168106: ["papad", "papadum", "appalam", "happala"],
}

# A note shown next to a hit where the USDA name is genuinely misleading.
ALIAS_NOTES = {
    172427: "USDA files urad dal under its botanical name, Mungo beans",
    174259: "USDA files urad dal under its botanical name, Mungo beans",
    2710168: "USDA has no separately measured ghee — these numbers are an "
             "anhydrous-milk-fat profile used as a proxy. Traditionally made "
             "cultured (bilona) ghee may differ, especially in fatty-acid detail.",
    173412: "Industrial anhydrous milk fat, not made by the ghee process. "
            "Fuller nutrient panel, but it is not ghee.",
    168933: "Semolina, not Cream of Wheat — the latter is a fortified US cereal",
}


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def fint(s):
    s = (s or "").strip()
    if s == "":
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def fnum(s):
    s = (s or "").strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def build():
    if not os.path.isdir(EXTRACTED):
        sys.exit(f"missing {EXTRACTED} — run the download/extract step first")

    check_display_config()
    stats = Counter()

    # ---- nutrient dictionary + the id <-> nbr map FNDDS needs -----------------
    nut_by_id, nbr_to_id = {}, {}
    for row in read_csv(os.path.join(EXTRACTED, DATASETS["SR"][0], "nutrient.csv")):
        nid = int(row["id"])
        nbr = (row.get("nutrient_nbr") or "").strip()
        try:
            nbr = str(int(float(nbr)))
        except ValueError:
            pass
        nut_by_id[nid] = {
            "id": nid,
            "nbr": nbr,
            "name": row["name"],
            "magnitude": MAGNITUDE_FIX.get((row["unit_name"] or "").upper(), "mg"),
        }
        if nbr:
            nbr_to_id[nbr] = nid
    # Foundation ships a newer dictionary with a few renames; prefer its names.
    for row in read_csv(os.path.join(EXTRACTED, DATASETS["FF"][0], "nutrient.csv")):
        nid = int(row["id"])
        if nid in nut_by_id:
            nut_by_id[nid]["name"] = row["name"]

    # ---- derivation code lookup ---------------------------------------------
    der_code = {}
    for row in read_csv(
        os.path.join(EXTRACTED, DATASETS["SR"][0], "food_nutrient_derivation.csv")
    ):
        der_code[row["id"]] = (row.get("code") or "").strip()

    # ---- foods ---------------------------------------------------------------
    foods = {}
    for tag, (d, want_type) in DATASETS.items():
        for row in read_csv(os.path.join(EXTRACTED, d, "food.csv")):
            if row.get("data_type") != want_type:
                continue
            fid = fint(row.get("fdc_id"))
            if fid is None:
                continue
            foods[fid] = {
                "fdc_id": fid,
                "description": row["description"],
                "data_type": want_type,
                "source": tag,
                "ndb": None,
            }
        stats[f"foods_{tag}"] = sum(
            1 for f in foods.values() if f["source"] == tag
        )
    # SR NDB numbers — the join key the iodine overlay needs
    for row in read_csv(os.path.join(EXTRACTED, DATASETS["SR"][0], "sr_legacy_food.csv")):
        fid = fint(row.get("fdc_id"))
        if fid is not None and fid in foods:
            foods[fid]["ndb"] = str(row["NDB_number"]).zfill(5)

    # ---- food nutrients ------------------------------------------------------
    fn_rows = []
    neg = 0
    for tag, (d, _) in DATASETS.items():
        translated = 0
        for row in read_csv(os.path.join(EXTRACTED, d, "food_nutrient.csv")):
            fid = fint(row.get("fdc_id"))
            if fid is None or fid not in foods:
                continue
            raw_nid = (row["nutrient_id"] or "").strip()
            if tag == "FN":
                # D11: FNDDS stores nutrient_nbr here, not the FDC id.
                nid = nbr_to_id.get(raw_nid)
                if nid is None:
                    continue
                translated += 1
            else:
                nid = fint(raw_nid)
                if nid is None:
                    continue
            if nid not in nut_by_id:
                continue

            amt = fnum(row.get("amount"))
            code = der_code.get((row.get("derivation_id") or "").strip(), "")

            if amt is None:
                stats["skipped_blank_amount"] += 1
                continue  # D3: blank -> no row -> reads as Absent

            raw_amt, clamped = None, 0
            if amt < 0:
                # D3: carbohydrate by difference legitimately goes negative on fatty
                # meats. Clamp, but keep the source value so the clamp is auditable.
                neg += 1
                raw_amt, amt, clamped = amt, 0.0, 1

            if amt > 0:
                kind, store_amt, upper = "measured", amt, None
            elif code in ASSUMED_ZERO_CODES:
                kind, store_amt, upper = "assumed_zero", 0.0, None
            elif code.startswith(ANALYTICAL_PREFIXES) or code in CALCULATED_CODES:
                kind, store_amt, upper = "measured_zero", 0.0, None
            else:
                # A zero with no provenance. We cannot claim the food contains none,
                # and the LOQ that would bound it is stripped from every bulk download.
                kind, store_amt, upper = "zero_unknown", None, None
            stats[f"kind_{kind}"] += 1

            fn_rows.append(
                (fid, nid, kind, store_amt, upper, raw_amt, clamped, code or None, tag)
            )
        if tag == "FN":
            stats["fndds_translated"] = translated

    # ---- portions ------------------------------------------------------------
    portions = []
    for tag, (d, _) in DATASETS.items():
        p = os.path.join(EXTRACTED, d, "food_portion.csv")
        if not os.path.exists(p):
            continue
        for row in read_csv(p):
            fid = fint(row.get("fdc_id"))
            if fid is None or fid not in foods:
                stats["skipped_portion_bad_fdc_id"] += 1 if fid is None else 0
                continue
            gw = fnum(row.get("gram_weight"))
            if not gw or gw <= 0:
                stats["skipped_bad_gram_weight"] += 1
                continue
            amount = fnum(row.get("amount"))
            if tag == "FN":
                # D1: FNDDS leaves amount blank on all 22,046 rows; the quantity lives
                # in portion_description ("1 cup"). One portion == gram_weight grams.
                amount = 1.0
            if amount is None or amount <= 0:
                stats["skipped_bad_amount"] += 1
                continue
            unit = (row.get("modifier") or "").strip() or None
            desc = (row.get("portion_description") or "").strip() or None
            portions.append((fid, amount, unit, desc, gw, tag))

    # ---- iodine overlay ------------------------------------------------------
    iodine_rows = iodine_overlay(foods)

    # ---- write ---------------------------------------------------------------
    os.makedirs(os.path.dirname(OUT_DB), exist_ok=True)
    if os.path.exists(OUT_DB):
        os.remove(OUT_DB)
    con = sqlite3.connect(OUT_DB)
    con.executescript(SCHEMA)

    tracked = set(nut_by_id)
    def nutrient_row(n):
        nid = n["id"]
        disp = DISPLAY_MAP.get(nid)
        if disp:
            group, order, tier = disp
            role = "primary"
        else:
            group, order, tier = None, 9999, "core"
            role = NON_DISPLAY_ROLES.get(nid, "component")
        return (
            nid, n["nbr"], n["name"], SHORT_NAMES.get(nid, n["name"]), n["magnitude"],
            BASIS.get(nid, "energy" if n["magnitude"] in ("kcal", "kJ") else "mass"),
            role, tier, group, order,
        )

    con.executemany(
        "INSERT INTO nutrients"
        " (id,nbr,name,short_name,magnitude,basis,role,tier,display_group,display_order)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        [nutrient_row(n) for n in nut_by_id.values()],
    )
    con.executemany(
        "INSERT INTO foods (fdc_id,description,data_type,source,ndb_number) VALUES (?,?,?,?,?)",
        [(f["fdc_id"], f["description"], f["data_type"], f["source"], f["ndb"]) for f in foods.values()],
    )
    con.executemany(
        "INSERT OR IGNORE INTO food_nutrients "
        "(fdc_id,nutrient_id,value_kind,amount,upper_bound,raw_amount,clamped,derivation,source) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        fn_rows,
    )
    con.executemany(
        "INSERT OR IGNORE INTO food_nutrients "
        "(fdc_id,nutrient_id,value_kind,amount,upper_bound,raw_amount,clamped,derivation,source) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        iodine_rows,
    )
    con.executemany(
        "INSERT INTO food_portions (fdc_id,amount,unit,description,gram_weight,source) "
        "VALUES (?,?,?,?,?,?)",
        portions,
    )
    alias_rows = []
    for fid, names in ALIASES.items():
        for a in names:
            alias_rows.append((a, fid, ALIAS_NOTES.get(fid)))
    con.executemany(
        "INSERT INTO food_aliases (alias, fdc_id, note) VALUES (?,?,?)", alias_rows
    )
    # Index the alias text alongside the description so an Indian name finds the
    # food. Without this, "urad dal" returns nothing at all.
    con.execute(
        """INSERT INTO foods_fts(rowid, description)
           SELECT f.fdc_id,
                  f.description || ' ' ||
                  COALESCE((SELECT group_concat(a.alias, ' ')
                            FROM food_aliases a WHERE a.fdc_id = f.fdc_id), '')
           FROM foods f"""
    )
    for k, v in [
        ("schema_version", "1"),
        ("foundation_release", "2026-04-30"),
        ("sr_legacy_release", "2018-04"),
        ("fndds_release", "2024-10-31"),
        ("iodine_release", "4"),
    ]:
        con.execute("INSERT INTO meta (key,value) VALUES (?,?)", (k, v))
    con.commit()

    verify(con, stats, neg, len(iodine_rows))
    con.execute("VACUUM")
    con.close()

    size = os.path.getsize(OUT_DB) / (1024 * 1024)
    print(f"\nwrote {OUT_DB}  ({size:.2f} MB)")


def iodine_overlay(foods):
    """USDA/ARS publishes iodine separately; FDC does not fold it in.

    The join key is the spreadsheet's column B ("Standard Reference (Foundation Foods)
    FDC NDB No."), NOT column A `DB_ID`, which is an internal identifier that will
    silently mismatch. Without this overlay iodine has zero rows in SR Legacy.
    """
    import re
    import xml.etree.ElementTree as ET
    import zipfile

    if not os.path.exists(IODINE_XLSX):
        print("  ! iodine workbook missing; skipping overlay")
        return []
    NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    z = zipfile.ZipFile(IODINE_XLSX)
    shared = [
        "".join(t.text or "" for t in si.iter(NS + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si")
    ]
    by_ndb = {f["ndb"]: f["fdc_id"] for f in foods.values() if f.get("ndb")}
    out, matched = [], 0
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(NS + "row"):
        cells = []
        for c in row:
            v = c.find(NS + "v")
            cells.append(
                "" if v is None else (shared[int(v.text)] if c.get("t") == "s" else v.text)
            )
        if len(cells) < 6:
            continue
        m = re.match(r"\s*(\d{4,5})", str(cells[1] or ""))
        amt = fnum(cells[5])
        if not m or amt is None:
            continue
        fid = by_ndb.get(m.group(1).zfill(5))
        if fid is None:
            continue
        matched += 1
        out.append((fid, 1100, "measured", amt, None, None, 0, "IODINE_DB", "IODINE"))
    print(f"  iodine overlay: {matched} foods matched")
    return out


def check_display_config():
    """Every displayed nutrient needs a short label, and every short label must
    belong to a displayed nutrient. Checked before the build so a typo'd id
    fails immediately rather than producing a silently mislabelled panel."""
    displayed = set(DISPLAY_MAP)
    missing = displayed - set(SHORT_NAMES)
    extra = set(SHORT_NAMES) - displayed
    if missing or extra:
        if missing:
            print(f"  ! displayed nutrients with no short name: {sorted(missing)}")
        if extra:
            print(f"  ! short names for non-displayed nutrients: {sorted(extra)}")
        sys.exit(1)


def verify(con, stats, neg, iodine_n):
    """Assertions that fail the build rather than shipping silently-wrong data."""
    print("\n--- ingest report ---")
    for k in sorted(stats):
        print(f"  {k:<28} {stats[k]:>8}")
    print(f"  {'negative_clamped':<28} {neg:>8}")

    q = lambda s: con.execute(s).fetchone()[0]
    foods_n = q("SELECT COUNT(*) FROM foods")
    fn_n = q("SELECT COUNT(*) FROM food_nutrients")
    port_n = q("SELECT COUNT(*) FROM food_portions")
    print(f"\n  foods={foods_n}  food_nutrients={fn_n}  portions={port_n}")

    problems = []

    # D11: if FNDDS translation silently failed we would lose 353k rows.
    if stats.get("fndds_translated", 0) < 300_000:
        problems.append(
            f"FNDDS translation produced only {stats.get('fndds_translated',0)} rows "
            "— nutrient_nbr mapping likely broken"
        )
    # D3: a spike means upstream changed something.
    if neg > 25:
        problems.append(f"{neg} negative amounts (expected <=25)")
    # D1: every portion must carry a usable gram weight.
    if q("SELECT COUNT(*) FROM food_portions WHERE gram_weight IS NULL OR gram_weight<=0"):
        problems.append("portions with non-positive gram_weight")
    # D2: Absent is the absence of a row; it must never be stored.
    if q("SELECT COUNT(*) FROM food_nutrients WHERE value_kind='absent'"):
        problems.append("'absent' stored as a row")
    # FTS must actually be populated or search silently returns nothing.
    if q("SELECT COUNT(*) FROM foods_fts") != foods_n:
        problems.append("FTS row count != foods row count")
    dangling = q(
        "SELECT COUNT(*) FROM food_aliases a "
        "LEFT JOIN foods f ON f.fdc_id = a.fdc_id WHERE f.fdc_id IS NULL"
    )
    if dangling:
        problems.append(f"{dangling} aliases point at a food that does not exist")
    n_alias = q("SELECT COUNT(*) FROM food_aliases")
    n_alias_foods = q("SELECT COUNT(DISTINCT fdc_id) FROM food_aliases")
    print(f"  aliases: {n_alias} names over {n_alias_foods} foods")
    if n_alias_foods != len(ALIASES):
        problems.append(f"{n_alias_foods} aliased foods, expected {len(ALIASES)}")
    displayed = q("SELECT COUNT(*) FROM nutrients WHERE role='primary'")
    expected = sum(len(items) for _g, items in DISPLAY)
    if displayed != expected:
        problems.append(f"{displayed} displayed nutrients, expected {expected}")
    print(f"\n  displayed nutrients: {displayed} (of {q('SELECT COUNT(*) FROM nutrients')})")
    if iodine_n < 300:
        problems.append(f"iodine overlay matched only {iodine_n} foods (expected ~369)")

    print("\n  value_kind distribution:")
    for kind, n in con.execute(
        "SELECT value_kind, COUNT(*) FROM food_nutrients GROUP BY 1 ORDER BY 2 DESC"
    ):
        print(f"    {kind:<16} {n:>8}")

    if problems:
        print("\nFAILED:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("\n  all assertions passed")


SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE nutrients (
  id        INTEGER PRIMARY KEY,
  nbr       TEXT,
  name      TEXT NOT NULL,
  short_name TEXT NOT NULL,
  magnitude TEXT NOT NULL CHECK (magnitude IN ('g','mg','ug','kcal','kJ','IU')),
  basis     TEXT NOT NULL CHECK (basis IN
              ('mass','energy','rae','retinol','dfe','folic_acid','alpha_te','ne',
               'iu_a','iu_d','iu_e')),
  role      TEXT NOT NULL CHECK (role IN ('primary','component','alternate','ul_source')),
  tier      TEXT NOT NULL CHECK (tier IN ('core','extended')),
  display_group TEXT,
  display_order INTEGER NOT NULL DEFAULT 9999,
  -- Only displayed nutrients carry a group; everything else must not be one.
  CHECK ((role = 'primary') = (display_group IS NOT NULL))
);

CREATE TABLE foods (
  fdc_id      INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  data_type   TEXT NOT NULL,
  source      TEXT NOT NULL,
  ndb_number  TEXT
);

-- A nutrient value is a tagged union (docs/decisions.md D2). `Absent` is represented
-- by the ABSENCE of a row and is never stored, so no query can mistake it for a zero.
CREATE TABLE food_nutrients (
  fdc_id      INTEGER NOT NULL REFERENCES foods(fdc_id),
  nutrient_id INTEGER NOT NULL REFERENCES nutrients(id),
  value_kind  TEXT NOT NULL CHECK (value_kind IN
                ('measured','measured_zero','assumed_zero','zero_unknown',
                 'below_loq','label_zero','trace')),
  amount      REAL,
  upper_bound REAL,
  raw_amount  REAL,
  clamped     INTEGER NOT NULL DEFAULT 0 CHECK (clamped IN (0,1)),
  derivation  TEXT,
  source      TEXT NOT NULL,
  PRIMARY KEY (fdc_id, nutrient_id),
  CHECK (amount IS NULL OR amount >= 0),
  CHECK (upper_bound IS NULL OR upper_bound > 0),
  -- each kind pins exactly which numeric columns may be present
  CHECK (
      (value_kind = 'measured'      AND amount IS NOT NULL AND upper_bound IS NULL)
   OR (value_kind IN ('measured_zero','assumed_zero')
                                    AND amount = 0.0        AND upper_bound IS NULL)
   OR (value_kind = 'zero_unknown'  AND amount IS NULL     AND upper_bound IS NULL)
   OR (value_kind IN ('below_loq','label_zero','trace')
                                    AND amount IS NULL     AND upper_bound IS NOT NULL)
  ),
  CHECK (clamped = 0 OR raw_amount IS NOT NULL)
) WITHOUT ROWID;

-- D1: amount and gram_weight stay separate. One portion == gram_weight grams.
CREATE TABLE food_portions (
  id          INTEGER PRIMARY KEY,
  fdc_id      INTEGER NOT NULL REFERENCES foods(fdc_id),
  amount      REAL NOT NULL CHECK (amount > 0),
  unit        TEXT,
  description TEXT,
  gram_weight REAL NOT NULL CHECK (gram_weight > 0),
  source      TEXT NOT NULL
);

-- No index on nutrient_id: the WITHOUT ROWID primary key (fdc_id, nutrient_id)
-- already covers the hot path (all nutrients for a logged food), and a secondary
-- index on nutrient_id alone cost 10.75 MB of the bundled database for queries v1
-- does not run. Add it back if "which foods are highest in X" becomes a feature.
CREATE INDEX idx_portion_food ON food_portions(fdc_id);
CREATE INDEX idx_foods_ndb ON foods(ndb_number);

CREATE TABLE food_aliases (
  alias  TEXT NOT NULL,
  fdc_id INTEGER NOT NULL REFERENCES foods(fdc_id),
  note   TEXT,
  PRIMARY KEY (alias, fdc_id)
) WITHOUT ROWID;
CREATE INDEX idx_alias_food ON food_aliases(fdc_id);

CREATE VIRTUAL TABLE foods_fts USING fts5(description, content='');
"""


if __name__ == "__main__":
    build()
