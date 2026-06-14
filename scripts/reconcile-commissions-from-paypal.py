#!/usr/bin/env python3
"""
Reconcile commissions: compta base + PayPal payment grouping.
Rule: regroup client payments into projects, never 1 virement = 1 commission.
"""
from __future__ import annotations

import importlib.util
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAYPAL_MD = ROOT / "import" / "paypal_stuff.md"
COMMISSIONS_JSON = ROOT / "import" / "commissions.json"
SEED_JSON = ROOT / "pages" / "assets" / "commissions-seed.json"
WORKBOOK_JSON = ROOT / "backend" / "tmp" / "lusciana-workbook.json"

# Canonical Mars–Oct 2025 projects (after duplicate cleanup)
CANONICAL_WORLDS = {
    "c-Alkazia", "c-Aly", "c-Atsuki-spawn-3-villes-pokemon", "c-AxDev-donjon-dedou-fiv",
    "c-Dawn", "c-Deuxbr", "c-Deuxbr-modification-spawn", "c-Deuxbr-modif-sombrosia",
    "c-Dina", "c-naruto-theo-granet", "c-Neloria-neloria-florian-nicolas-montchamp",
    "c-Neloria-scale-80-10", "c-Hesty", "c-Hichibo", "c-village", "c-CubeLock-cubelock-jules-fuselier",
    "c-JB-casino-steampunk-alexandre-coulondre", "c-Sombrosia-sombrosia-geoffrey-eaudouce",
    "c-Kamdin-modification-map-faction", "c-Kamdin", "c-Kellogs-pour-100-assets-kris-thaesler",
    "c-Kellogs-casino-steampunk-alexandre-coulondre", "c-Kyoka-kyoka-woze-suryoutube",
    "c-MagikViruz", "c-WanoKuni", "c-Muk", "c-ville", "c-Nuqm", "c-Nuqm-garage",
    "c-Nuqm-spawn-3-villes-pokemon", "c-Nuqm-ferme", "c-Nuqm-spawn-1j-nadir-lounes", "c-Nuqm-spawn",
    "c-o700iq-ile-skyblock-leo-oevho", "c-Pourtoutix-mariokart-mathis-mazoyer",
    "c-Pourtoutix-map-tower-x3", "c-Pourtoutix", "c-Sayame", "c-Sayame-map-survie",
    "c-Scale-neloria-florian-nicolas-montchamp", "c-Scale-scale-lucas-diez",
    "c-Shawzer-modification-map-faction", "c-Shinlass-mineframe-dream-days",
    "c-Skye", "c-Skye-shop-pokemon", "c-render-stasolaire-arnaud-stasolaire",
    "c-TryIs-5-spawn-1-hub", "c-TryIs", "c-TryIs-dev-mathis", "c-TryIs-donjon",
    "c-Ved-garage", "c-Ved-spawn", "c-Zosco", "c-Zosco-map-survie",
}

AMOUNT_RE = re.compile(
    r"^([+−\-])\s*([\d\s]+)[,.](\d{2})\s*(€|EUR|\$ USD|kr DKK)?",
    re.IGNORECASE,
)
MONTH_HEADER_RE = re.compile(
    r"^(janv|févr|fevr|avr|mai|juin|juil|août|aout|sept|oct|nov|déc)\.?\s+202[56]$",
    re.IGNORECASE,
)
WORLD_RE = re.compile(r"(c-[A-Za-z0-9_-]+)")

SKIP_LINES = {
    "tableau de bord", "accueil", "envoyer et demander", "portefeuille", "activité",
    "aide", "notifications", "paramètres", "déconnexion", "filter drawer",
    "download statement", "filtrer par", "envoyer un rappel", "répéter", "détails",
    "ajouter des informations de suivi", "terminé", "en attente", "cette semaine",
    "0 suggestions available", "recherchez par nom ou adresse email",
}

# PayPal incoming -> worldName (regroup multiple payments under one commission)
PAYPAL_TO_WORLD: list[tuple[str, str]] = [
    # Ved
    ("kyllian havret", "c-Ved-spawn"),
    ("waves organisation", "c-Ved-spawn"),
    # TryIs builds & dev (Titouan Rissoan)
    ("acompte pour le build de 5 spawn", "c-TryIs-5-spawn-1-hub"),
    ("5 spawn + 1 hub", "c-TryIs-5-spawn-1-hub"),
    ("fin build donjon de glace", "c-TryIs-donjon"),
    ("donjon de glace", "c-TryIs-donjon"),
    ("donjon slime", "c-TryIs-donjon"),
    ("fin build 2 donjons", "c-TryIs-donjon"),
    ("debut build des 7 forteresses", "c-TryIs-donjon"),
    ("forteresses", "c-TryIs-donjon"),
    ("terra des 5 spawn", "c-TryIs-donjon"),
    ("village medieval en ruine", "c-TryIs"),
    ("village tuto", "c-TryIs"),
    ("plugin caerwynn", "c-TryIs-dev-mathis"),
    ("caerwynn core", "c-TryIs-dev-mathis"),
    ("caerwynn v2", "c-TryIs-dev-mathis"),
    ("caerwynn v3", "c-TryIs-dev-mathis"),
    ("dev plugin", "c-TryIs-dev-mathis"),
    ("fin dev site", "c-TryIs-dev-mathis"),
    ("site web par mathis", "c-TryIs-dev-mathis"),
    ("titouan rissoan", "c-TryIs-dev-mathis"),
  # Skye
    ("alex carr", "c-Skye"),
    ("buildies", "c-Skye"),
    # Nuqm
    ("dimitri le louet", "c-Nuqm-spawn"),
    ("nuqm spawn", "c-Nuqm-spawn"),
    # Atsuki
    ("alexis sureau", "c-Atsuki-spawn-3-villes-pokemon"),
    # FilsOurs
    ("theo granet", "c-naruto-theo-granet"),
    # Muuk / Hugo / Dina
    ("bouguettaya", "c-ville"),
    ("gatsbi le cam", "c-ville"),
    ("hugo dones", "c-village"),
    ("saturngames", "c-Dina"),
    ("dina bouhaziz", "c-Dina"),
    # Dawn
    ("ledeux tristan", "c-Dawn"),
    ("killian dos santos", "c-Dawn"),
    ("commission dawn", "c-Dawn"),
    ("map donjon", "c-Dawn"),
    # Florian / Scale
    ("nicolas montchamp", "c-Neloria-neloria-florian-nicolas-montchamp"),
    ("lucas diez", "c-Scale-scale-lucas-diez"),
    ("lucas tisin", "c-Scale-scale-lucas-diez"),
    # Others 2025
    ("gregory hesty", "c-Hesty"),
    ("magik", "c-MagikViruz"),
    ("hichibo", "c-Hichibo"),
    ("dedou fiv", "c-AxDev-donjon-dedou-fiv"),
    ("woze suryoutube", "c-Kyoka-kyoka-woze-suryoutube"),
    ("arnaud stasolaire", "c-render-stasolaire-arnaud-stasolaire"),
    ("kamdin boyd", "c-Kamdin"),
    ("alex vansen", "c-Kamdin"),
    ("loopedsmp", "c-Kamdin"),
    ("alexandre coulondre", "c-Kellogs-casino-steampunk-alexandre-coulondre"),
    ("kris thaesler", "c-Kellogs-pour-100-assets-kris-thaesler"),
    ("dream days", "c-Shinlass-mineframe-dream-days"),
    ("clément bimboire", "c-Deuxbr"),
    ("clement bimboire", "c-Deuxbr"),
    ("callofcube", "c-Deuxbr"),
    ("oniris account", "c-CubeLock-cubelock-jules-fuselier"),
    ("alkazia", "c-Alkazia"),
    ("paul genreau", "c-NOX"),
    ("nox", "c-NOX"),
    # 2026
    ("evan white", "c-ARG_Maps"),
    ("arg builds", "c-ARG_Maps"),
    ("first half for arg", "c-ARG_Maps"),
    ("kylian junior", "c-Lysariel"),
    ("pablo henao", "c-Skyblock_Spawn"),
    ("skyblock spawn", "c-Skyblock_Spawn"),
    ("kamori map", "c-GOAT-spawn"),
    ("goat studios", "c-GOAT-spawn"),
    ("joe barre", "c-Sqotogaming"),
    ("sqotogaming", "c-Sqotogaming"),
    ("castle sqoto", "c-Sqotogaming-castle"),
    ("medievalspawn", "c-Medievalspawn"),
    ("arnaud lemoine", "c-Yggdrasil"),
    ("yggdrasil", "c-Yggdrasil"),
    ("kerrian bouvet", "c-LaPensine"),
    ("lapensine", "c-LaPensine"),
    ("jonathan abin", "c-Frozen"),
    ("frozen", "c-Frozen"),
    ("menoria", "c-Menoria"),
    ("laurent", "c-Menoria"),
]

SKIP_INCOMING = {
    "mathis mazoyer", "coraline uvina", "yoan delarue", "léo oevho", "leo oevho",
    "remboursement de paypal", "nosonveaux@gmail.com",
}

AUTO_SKIP = (
    "moulberry", "discord", "google payment", "ovh", "hostinger", "lcl sa",
    "uber", "patreon", "adn anime", "buildy network", "guillermo armenta",
    "jhon walt", "antoine maurette", "ced omlor", "galabau omlor",
    "archibald builder", "enzo martins", "hasuko haky", "marc van suyt",
    "noémie sonveaux", "matheo blain", "vivek sharma", "mads bertelsen",
    "jidnesh patil", "alexandre mongin", "perso shop", "eloise mont",
)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def slugify(value: str) -> str:
    return re.sub(r"-{2,}", "-", normalize(value).replace(" ", "-")).strip("-")


def parse_amount(line: str) -> tuple[float, bool] | None:
    m = AMOUNT_RE.match(line.replace("\u2212", "-").replace("−", "-"))
    if not m:
        return None
    sign, whole, frac, currency = m.groups()
    if currency and ("$" in currency or "DKK" in currency.upper()):
        return None
    amount = float(whole.replace(" ", "").replace("\u00a0", "") + "." + frac)
    return amount, sign == "+"


def parse_month_year(header: str) -> str:
    months = {
        "janv": 1, "fevr": 2, "avr": 4, "mai": 5, "juin": 6,
        "juil": 7, "aout": 8, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
    }
    parts = normalize(header).split()
    if len(parts) < 2:
        return "2025-06"
    for k, v in months.items():
        if parts[0].startswith(k[:3]):
            return f"{int(parts[-1])}-{v:02d}"
    return "2025-06"


def parse_paypal(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines()
    period = "2025-06"
    txs = []
    i = 0
    while i < len(lines):
        raw = lines[i].strip()
        i += 1
        if not raw or raw.lower() in SKIP_LINES or raw.lower().startswith("date:"):
            continue
        if MONTH_HEADER_RE.match(raw) or re.match(r"^[a-zéû]+\s+202[56]$", raw, re.I):
            period = parse_month_year(raw)
            continue
        name = raw
        if re.fullmatch(r"[A-Z]{2}", raw) and i < len(lines):
            name = lines[i].strip()
            i += 1
        if i >= len(lines):
            break
        parsed = parse_amount(lines[i].strip())
        if not parsed:
            continue
        amount, incoming = parsed
        i += 1
        if i >= len(lines):
            break
        date_line = lines[i].strip().lower()
        i += 1
        desc = ""
        if i < len(lines) and lines[i].strip().startswith('"'):
            desc = lines[i].strip().strip('"')
            i += 1
        if not incoming:
            continue
        if "réception" not in date_line and "paiement reçu" not in date_line:
            continue
        nn = normalize(name)
        if nn in SKIP_INCOMING or any(s in nn for s in AUTO_SKIP):
            continue
        txs.append({"name": name, "amount": amount, "period": period, "description": desc})
    return txs


def map_payment_to_world(tx: dict) -> str | None:
    blob = normalize(tx["name"] + " " + tx["description"])
    world = WORLD_RE.search(tx["description"])
    if world:
        w = world.group(1)
        if w in CANONICAL_WORLDS or w.startswith("c-"):
            return w
    best_world = None
    best_len = 0
    for needle, world in PAYPAL_TO_WORLD:
        if needle in blob and len(needle) > best_len:
            best_world = world
            best_len = len(needle)
    return best_world


def aggregate_paypal(txs: list[dict]) -> dict[str, dict]:
    agg: dict[str, dict] = {}
    for tx in txs:
        world = map_payment_to_world(tx)
        if not world:
            continue
        bucket = agg.setdefault(world, {"amounts": [], "periods": [], "descriptions": []})
        bucket["amounts"].append(tx["amount"])
        bucket["periods"].append(tx["period"])
        if tx["description"]:
            bucket["descriptions"].append(tx["description"])
    for world, data in agg.items():
        amounts = data["amounts"]
        data["total"] = round(sum(amounts), 2)
        data["deposit"] = round(sum(amounts[:-1]), 2) if len(amounts) > 1 else 0.0
    return agg


def infer_deposit(total: float, price: float, amounts: list[float], keep: float = 0.0) -> float:
    if not amounts:
        return keep
    if price <= 0:
        return round(total, 2)
    # PayPal bucket likely mixes several commissions — keep compta deposit
    if total > price * 1.08:
        return keep
    if total >= price and len(amounts) > 1:
        return round(min(sum(amounts[:-1]), price), 2)
    if total < price:
        return round(total, 2)
    return round(price, 2)


def month_iso_range(periods: list[str]) -> tuple[str, str]:
    if not periods:
        return "", ""
    import calendar
    ys = sorted(periods)
    y1, m1 = map(int, ys[0].split("-"))
    y2, m2 = map(int, ys[-1].split("-"))
    start = f"{y1}-{m1:02d}-01"
    l2 = calendar.monthrange(y2, m2)[1]
    end = f"{y2}-{m2:02d}-{l2:02d}"
    return start, end


def default_commission(**kwargs) -> dict:
    base = {
        "buildSize": "", "buildName": "", "worldName": "", "realizedBy": [],
        "version": "", "forCustomer": "yes", "price": 0.0, "buildStart": "", "buildEnd": "",
        "depositAmount": 0.0, "buildType": "commission", "organics": "yes",
        "selectedAgents": [], "priceDistribution": {}, "commissionPercent": 15.0,
        "wentWell": "yes", "clientName": "", "clientWants": "", "hasFeedback": "no",
        "clientFeedback": "", "render": "no", "showcaseText": "",
    }
    base.update(kwargs)
    return base


# New 2026 commissions (PayPal-backed, regrouped manually)
NEW_2026 = [
    default_commission(
        buildName="ARG Maps",
        worldName="c-ARG_Maps",
        price=520.0,
        depositAmount=260.6,
        buildStart="2026-05-01",
        buildEnd="2026-06-30",
        clientName="swxift",
        clientWants="ARG builds (First half received via PayPal)",
        selectedAgents=["Archibald", "_Shusui"],
    ),
    default_commission(
        buildName="Skyblock Spawn",
        worldName="c-Skyblock_Spawn",
        price=280.0,
        depositAmount=146.65,
        buildStart="2026-03-01",
        buildEnd="2026-05-31",
        clientName="Magik_Viruz",
        clientWants="Skyblock Spawn milestones (Sqotogaming / Pablo Henao)",
        selectedAgents=["Ced", "_Shusui"],
    ),
    default_commission(
        buildName="Lysariel",
        worldName="c-Lysariel",
        price=550.0,
        depositAmount=275.0,
        buildStart="2026-05-01",
        buildEnd="2026-06-30",
        clientName="Artyon_",
        clientWants="Lysariel spawn",
        selectedAgents=["Tanvik"],
    ),
    default_commission(
        buildName="Medieval Spawn",
        worldName="c-Medievalspawn",
        price=345.0,
        depositAmount=0.0,
        buildStart="2026-04-01",
        buildEnd="2026-05-31",
        clientName="Sqotogaming",
        clientWants="Medieval spawn (manager splits in PayPal)",
        commissionPercent=15.0,
    ),
    default_commission(
        buildName="Castle Sqoto",
        worldName="c-Sqotogaming-castle",
        price=170.0,
        depositAmount=0.0,
        buildStart="2026-04-01",
        buildEnd="2026-04-30",
        clientName="Sqotogaming",
        clientWants="Castle sqoto",
    ),
    default_commission(
        buildName="Yggdrasil",
        worldName="c-Yggdrasil",
        price=155.0,
        depositAmount=0.0,
        buildStart="2026-02-01",
        buildEnd="2026-04-30",
        clientName="Yggdrasil",
        clientWants="Build Lusciana Yggdrasil",
    ),
    default_commission(
        buildName="LaPensine",
        worldName="c-LaPensine",
        price=250.0,
        depositAmount=250.0,
        buildStart="2026-01-01",
        buildEnd="2026-01-31",
        clientName="LaPensine",
        clientWants="LaPensine",
    ),
    default_commission(
        buildName="Frozen",
        worldName="c-Frozen",
        price=76.5,
        depositAmount=10.0,
        buildStart="2026-01-01",
        buildEnd="2026-01-31",
        clientName="Frozen",
        clientWants="Frozen build",
    ),
    default_commission(
        buildName="Menoria structures",
        worldName="c-Menoria",
        price=200.0,
        depositAmount=84.61,
        buildStart="2025-12-01",
        buildEnd="2025-12-31",
        clientName="Menoria",
        clientWants="Acompte devis DEV2025-010 structures",
    ),
    default_commission(
        buildName="NOX RP",
        worldName="c-NOX",
        price=480.0,
        depositAmount=180.0,
        buildStart="2025-11-01",
        buildEnd="2025-11-30",
        clientName="NOX",
        clientWants="Serveur RP NOX (Paul Genreau 3/3)",
    ),
    default_commission(
        buildName="GOAT Kamori Map",
        worldName="c-GOAT-spawn",
        price=250.0,
        depositAmount=125.0,
        buildStart="2026-03-01",
        buildEnd="2026-03-31",
        clientName="GOAT",
        clientWants="Milestone Payment Kamori Map Development",
    ),
]


def sanitize_stored_deposit(comm: dict) -> None:
    price = float(comm.get("price") or 0)
    deposit = float(comm.get("depositAmount") or 0)
    if price > 0 and deposit > price * 1.05:
        comm["depositAmount"] = 0.0


def restore_canonical_base(path: Path) -> list[dict]:
    """Pick canonical commissions from file (may contain duplicates from bad run)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    by_world: dict[str, dict] = {}
    for item in data:
        w = item.get("worldName", "")
        if w in CANONICAL_WORLDS and w not in by_world:
            sanitize_stored_deposit(item)
            by_world[w] = item
    missing = CANONICAL_WORLDS - set(by_world)
    if missing:
        raise SystemExit(f"Missing canonical worlds in source: {sorted(missing)}")
    return [by_world[w] for w in sorted(by_world.keys(), key=lambda x: (
        by_world[x].get("clientName", ""), x
    ))]


def enrich_from_paypal(commissions: list[dict], paypal_agg: dict[str, dict]) -> None:
    for comm in commissions:
        world = comm["worldName"]
        data = paypal_agg.get(world)
        if not data:
            continue
        price = float(comm.get("price") or 0)
        total = data["total"]
        amounts = data["amounts"]
        keep = float(comm.get("depositAmount") or 0)
        if price > 0:
            comm["depositAmount"] = infer_deposit(total, price, amounts, keep)
        elif total > 0:
            comm["price"] = total
            comm["depositAmount"] = infer_deposit(total, total, amounts, keep)
        if not comm.get("buildStart"):
            start, end = month_iso_range(data["periods"])
            comm["buildStart"] = start
            comm["buildEnd"] = end
        if any("render" in normalize(d) for d in data["descriptions"]):
            comm["render"] = "yes"


def main() -> None:
    txs = parse_paypal(PAYPAL_MD)
    paypal_agg = aggregate_paypal(txs)

    commissions = restore_canonical_base(COMMISSIONS_JSON)
    enrich_from_paypal(commissions, paypal_agg)

    # Special: Ved spawn — PayPal total 280 (80+90+110)
    # Compta-backed deposits when PayPal buckets mix several projects
    COMPTA_DEPOSITS = {
        "c-TryIs-dev-mathis": 960.0,
        "c-TryIs": 92.52,
        "c-Nuqm-garage": 133.14,
        "c-Skye-shop-pokemon": 112.78,
    }
    for comm in commissions:
        world = comm["worldName"]
        if world == "c-Ved-spawn":
            comm["price"] = 280.0
            comm["depositAmount"] = 170.0
        elif world == "c-Ved-garage":
            comm["depositAmount"] = 0.0 if world not in paypal_agg else comm["depositAmount"]
        elif float(comm.get("depositAmount") or 0) <= 0 and world in COMPTA_DEPOSITS:
            comm["depositAmount"] = COMPTA_DEPOSITS[world]

    existing_worlds = {c["worldName"] for c in commissions}
    for new in NEW_2026:
        if new["worldName"] not in existing_worlds:
            enrich_from_paypal([new], paypal_agg)
            commissions.append(new)
            existing_worlds.add(new["worldName"])

    commissions.sort(key=lambda c: (c.get("clientName", ""), c.get("buildStart", ""), c.get("worldName", "")))

    COMMISSIONS_JSON.write_text(json.dumps(commissions, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    SEED_JSON.write_text(json.dumps(commissions, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    summary = {
        "paypal_incoming_client_mapped": len(txs),
        "paypal_world_buckets": len(paypal_agg),
        "total_commissions": len(commissions),
        "canonical_2025": len(CANONICAL_WORLDS),
        "new_2026": len(NEW_2026),
        "paypal_totals_sample": {k: v["total"] for k, v in sorted(paypal_agg.items())[:20]},
    }
    (ROOT / "import" / "reconcile-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
