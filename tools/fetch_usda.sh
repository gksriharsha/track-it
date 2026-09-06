#!/usr/bin/env bash
# Download and extract the USDA bulk data that tools/build_reference_db.py reads.
#
# Idempotent: an archive already present and matching tools/sources.sha256 is not
# re-downloaded, and extraction is skipped when the tree is already in place.
# Together with build_reference_db.py this is the whole path from a clean
# checkout to src-tauri/resources/usda_core.db, and it is what CI runs.
#
# Layout note. The three FoodData Central archives each contain a single
# top-level directory named after the archive, so they extract straight into
# extracted/. IODINE_RELEASE_4.zip has its two spreadsheets at the archive root
# instead, so it gets a directory of its own — build_reference_db.py looks for
# the file under extracted/iodine/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="$ROOT/data/raw"
EXTRACTED="$RAW/extracted"
FDC_BASE="https://fdc.nal.usda.gov/fdc-datasets"

FDC_ARCHIVES=(
  "FoodData_Central_foundation_food_csv_2026-04-30.zip"
  "FoodData_Central_sr_legacy_food_csv_2018-04.zip"
  "FoodData_Central_survey_food_csv_2024-10-31.zip"
)
IODINE_ARCHIVE="IODINE_RELEASE_4.zip"
IODINE_URL="https://www.ars.usda.gov/ARSUserFiles/80400535/Data/Iodine/$IODINE_ARCHIVE"

mkdir -p "$RAW" "$EXTRACTED"

fetch() {
  local name="$1" url="$2"
  if [ -f "$RAW/$name" ]; then
    echo "have    $name"
  else
    echo "fetch   $name"
    curl -fL --retry 3 --retry-delay 2 -o "$RAW/$name.part" "$url"
    mv "$RAW/$name.part" "$RAW/$name"
  fi
}

for a in "${FDC_ARCHIVES[@]}"; do fetch "$a" "$FDC_BASE/$a"; done
fetch "$IODINE_ARCHIVE" "$IODINE_URL"

# Fail loudly on source drift rather than silently building a different database.
echo "verify  tools/sources.sha256"
# GNU sha256sum warns on every comment line, so the file is stripped to its
# digest lines before it is fed in.
SUMS="$(grep -vE '^[[:space:]]*(#|$)' "$ROOT/tools/sources.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RAW" && printf '%s\n' "$SUMS" | sha256sum --check --strict -)
else
  (cd "$RAW" && printf '%s\n' "$SUMS" | shasum -a 256 --check --strict -)
fi

for a in "${FDC_ARCHIVES[@]}"; do
  dir="$EXTRACTED/${a%.zip}"
  if [ -d "$dir" ]; then
    echo "have    ${a%.zip}/"
  else
    echo "extract ${a%.zip}/"
    unzip -qo "$RAW/$a" -d "$EXTRACTED"
  fi
done

if [ -d "$EXTRACTED/iodine" ]; then
  echo "have    iodine/"
else
  echo "extract iodine/"
  unzip -qo "$RAW/$IODINE_ARCHIVE" -d "$EXTRACTED/iodine"
fi

echo "ready   $EXTRACTED"
