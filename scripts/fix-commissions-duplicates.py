#!/usr/bin/env python3
"""Fix known duplicate / mis-assigned commissions in import/commissions.json."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = [
    ROOT / "import" / "commissions.json",
    ROOT / "pages" / "assets" / "commissions-seed.json",
]

REMOVE_WORLD_NAMES = {
    "c-Ved-map-tower-x3",
    "c-Ved",  # garage renommé c-Ved-garage
    "c-WanoKuni-soymemox-guillrmo-armenta",
    "c-Scale-soymemox-guillrmo-armenta",
    "c-soymemox-guillrmo-armenta",
}

OBSOLETE_JSON = ROOT / "pages" / "assets" / "obsolete-commission-worlds.json"

RENDER_WORLD_NAMES = {
    "c-WanoKuni",
    "c-render-stasolaire-arnaud-stasolaire",
    "c-Scale-neloria-florian-nicolas-montchamp",
}

DEPOSIT_FIXES = {
    "c-Ved-spawn": 170.0,
}


def fix_file(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    before = len(data)

    kept = []
    for item in data:
        world = item.get("worldName", "")
        if world in REMOVE_WORLD_NAMES:
            continue
        if world in DEPOSIT_FIXES:
            item["depositAmount"] = DEPOSIT_FIXES[world]
        if world in RENDER_WORLD_NAMES:
            item["render"] = "yes"
        if world == "c-Ved" and item.get("buildName") == "Garage":
            item["worldName"] = "c-Ved-garage"
        kept.append(item)

    path.write_text(json.dumps(kept, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{path.name}: {before} -> {len(kept)} commissions")


for source in SOURCES:
    fix_file(source)

OBSOLETE_JSON.write_text(
    json.dumps(
        {
            "description": "worldName à supprimer en base (erreurs d'import seed). Sync ObsoleteCommissionWorlds.php",
            "worldNames": sorted(REMOVE_WORLD_NAMES),
        },
        indent=2,
        ensure_ascii=False,
    ) + "\n",
    encoding="utf-8",
)
print(f"obsolete-commission-worlds.json: {len(REMOVE_WORLD_NAMES)} entrées")
