#!/usr/bin/env python3

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT_DIR / "backend"
EXPORT_SCRIPT = Path(__file__).resolve().parent / "export-lusciana-workbook.py"
DEFAULT_SOURCE = Path("/home/luna/luna-admin/backend/tmp/Comptabilite-Lusciana.xlsx")
DEFAULT_WORKBOOK_JSON = BACKEND_DIR / "tmp" / "lusciana-workbook.json"
DEFAULT_PREVIEW_JSON = BACKEND_DIR / "tmp" / "lusciana-import-preview.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importe Comptabilité Lusciana dans MongoDB.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Chemin du fichier XLSX source")
    parser.add_argument("--workbook-json", default=str(DEFAULT_WORKBOOK_JSON), help="Chemin du JSON intermédiaire")
    parser.add_argument("--output", default=str(DEFAULT_PREVIEW_JSON), help="Chemin du JSON preview/import")
    parser.add_argument("--write", action="store_true", help="Écrit réellement en base MongoDB")
    return parser.parse_args()


def ensure_directory(file_path: Path) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)


def export_workbook(source: Path, workbook_json: Path) -> None:
    ensure_directory(workbook_json)
    result = subprocess.run(
        [sys.executable, str(EXPORT_SCRIPT), str(source), str(workbook_json)],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout or "Workbook export failed")


def read_json(file_path: Path):
    with file_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def as_string(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def as_number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        normalized = value.replace(" ", "").replace(",", ".")
        try:
            return float(normalized)
        except ValueError:
            return None
    return None


def normalize_text(value) -> str:
    text = as_string(value)
    replacements = {
        "à": "a",
        "â": "a",
        "ä": "a",
        "á": "a",
        "ã": "a",
        "å": "a",
        "ç": "c",
        "é": "e",
        "è": "e",
        "ê": "e",
        "ë": "e",
        "í": "i",
        "ì": "i",
        "î": "i",
        "ï": "i",
        "ñ": "n",
        "ó": "o",
        "ò": "o",
        "ô": "o",
        "ö": "o",
        "õ": "o",
        "ú": "u",
        "ù": "u",
        "û": "u",
        "ü": "u",
        "ý": "y",
        "ÿ": "y",
        "œ": "oe",
    }
    text = text.lower()
    for source, target in replacements.items():
        text = text.replace(source, target)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()


def slugify(value) -> str:
    return re.sub(r"-{2,}", "-", normalize_text(value).replace(" ", "-")).strip("-")


def unique(values):
    result = []
    seen = set()
    for value in values:
        if not value:
            continue
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def is_name_like(value) -> bool:
    text = as_string(value)
    if not text:
        return False
    if re.fullmatch(r"\d+([.,]\d+)?", text):
        return False
    return re.search(r"[A-Za-zÀ-ÿ]", text) is not None


def dedupe_names(values):
    result = {}
    for value in values:
        text = as_string(value)
        if not is_name_like(text):
            continue
        key = normalize_text(text)
        if key and key not in result:
            result[key] = text
    return list(result.values())


def month_sheets(workbook):
    return [sheet for sheet in workbook.get("sheets", []) if sheet.get("name") != "Total"]


def extract_names_from_columns(sheet, header_pattern: re.Pattern, name_offset: int):
    collected = []
    rows = sheet.get("rows", [])
    max_rows = min(len(rows), 18)

    for row_index in range(max_rows):
        row = rows[row_index] or []
        for col_index, cell in enumerate(row):
            if not header_pattern.search(normalize_text(cell)):
                continue

            next_limit = min(len(rows), row_index + 16)
            for next_row in range(row_index + 1, next_limit):
                source_row = rows[next_row] or []
                code = as_string(source_row[col_index] if col_index < len(source_row) else None)
                candidate_index = col_index + name_offset
                candidate = as_string(source_row[candidate_index] if candidate_index < len(source_row) else None)
                if not candidate or not code:
                    continue
                if re.match(r"^journal\b", candidate, flags=re.IGNORECASE) or re.match(r"^mois\b", candidate, flags=re.IGNORECASE):
                    break
                if not re.fullmatch(r"\d{4,}", code) or not is_name_like(candidate):
                    break
                collected.append(candidate)

    return dedupe_names(collected)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def extract_agents(workbook):
    clients = {}
    associates = {}
    suppliers = {}

    for sheet in month_sheets(workbook):
        for name in extract_names_from_columns(sheet, re.compile(r"^liste de client"), 1):
            clients[normalize_text(name)] = name
        for name in extract_names_from_columns(sheet, re.compile(r"^liste d associe"), 1):
            associates[normalize_text(name)] = name
        for name in extract_names_from_columns(sheet, re.compile(r"^liste de fournisseur"), 1):
            suppliers[normalize_text(name)] = name

    now = iso_now()
    items = []

    for key, pseudo in sorted(associates.items(), key=lambda item: item[1].lower()):
        items.append(
            {
                "pseudo": pseudo,
                "category": "builder",
                "discord": "",
                "paymentMethods": [],
                "pf": "",
                "commissionRate": 0,
                "memberSince": "",
                "isCompany": False,
                "iban": "",
                "country": "",
                "address": "",
                "companyName": "",
                "createdAt": now,
                "updatedAt": now,
                "legacyImport": {
                    "source": "Comptabilité Lusciana.xlsx",
                    "role": "associate",
                },
            }
        )
        clients.pop(key, None)

    for pseudo in sorted(clients.values(), key=str.lower):
        items.append(
            {
                "pseudo": pseudo,
                "category": "client",
                "discord": "",
                "paymentMethods": [],
                "pf": "",
                "commissionRate": 0,
                "memberSince": "",
                "isCompany": False,
                "iban": "",
                "country": "",
                "address": "",
                "companyName": "",
                "createdAt": now,
                "updatedAt": now,
                "legacyImport": {
                    "source": "Comptabilité Lusciana.xlsx",
                    "role": "client",
                },
            }
        )

    return {
        "items": items,
        "clients": list(clients.values()),
        "associates": list(associates.values()),
        "suppliers": list(suppliers.values()),
    }


def is_generic_context(text: str) -> bool:
    normalized = normalize_text(text)
    return (
        normalized == ""
        or normalized in {"banque", "prestation de service", "perte de change", "recu", "re u", "acompte recu", "paiement recu", "pourcentage", "depense team", "total"}
        or normalized.startswith("journal de ")
        or normalized.startswith("mois d")
        or normalized.startswith("mois de ")
    )


def get_context_texts(sheet_rows, row_index: int, col_index: int):
    values = []
    for current_row in range(max(0, row_index - 1), min(len(sheet_rows) - 1, row_index + 3) + 1):
        row = sheet_rows[current_row] or []
        for current_col in range(max(0, col_index - 1), min(len(row) - 1, col_index + 1) + 1):
            text = as_string(row[current_col])
            if not text or re.fullmatch(r"\d+([.,]\d+)?", text) or is_generic_context(text):
                continue
            values.append(text)
    return unique(values)


def get_amount_near_label(row, col_index: int) -> float:
    for offset in (2, 3, 1, 4):
        target = col_index + offset
        if target >= len(row):
            continue
        number = as_number(row[target])
        if number is not None and 0 < number < 100000:
            return number
    return 0.0


def clean_project_text(value, actor_name: str) -> str:
    text = normalize_text(value)
    actor = normalize_text(actor_name)
    if actor:
        text = text.replace(actor, " ")
    text = re.sub(r"\b(client|acompte client|associe|fournisseur)\b", " ", text)
    text = re.sub(r"\b(devis|facture|acompte|paiement|payement|payment|recu|pour|paypal|divise|divisee|render|banque|prestation|service|perte|change|mois|journal)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def best_description(label: str, context_texts):
    candidates = []
    for text in context_texts:
        if normalize_text(text) == normalize_text(label):
            continue
        if re.match(r"^(Acompte Client|Client|Associ[eé]|Fournisseur)\s*-\s*", text, flags=re.IGNORECASE):
            continue
        candidates.append(text)

    if not candidates:
        return label

    preferred = sorted(
        [text for text in candidates if re.search(r"(devis|facture|acompte|paiement|payement|paypal|render)", text, flags=re.IGNORECASE)],
        key=len,
        reverse=True,
    )
    if preferred:
        return preferred[0].strip()

    return sorted(candidates, key=len, reverse=True)[0].strip()


def project_key_for_event(event) -> str:
    primary = clean_project_text(event["description"], event["name"])
    if primary:
        return f"{normalize_text(event['name'])}::{primary}"
    return f"{normalize_text(event['name'])}::{event['month'].lower()}::{event['row']}"


def scan_events(workbook):
    client_events = []
    associate_events = []

    for sheet in month_sheets(workbook):
        rows = sheet.get("rows", [])
        for row_index, row in enumerate(rows):
            row = row or []
            for col_index, cell in enumerate(row):
                cell_text = as_string(cell)
                if not cell_text:
                    continue

                client_match = re.match(r"^(Acompte Client|Client)\s*-\s*(.+)$", cell_text, flags=re.IGNORECASE)
                if client_match:
                    event_type = "deposit" if re.match(r"^acompte client", client_match.group(1), flags=re.IGNORECASE) else "invoice"
                    name = client_match.group(2).strip()
                    context_texts = get_context_texts(rows, row_index, col_index)
                    description = best_description(cell_text, context_texts)
                    client_events.append(
                        {
                            "sourceId": f"{sheet['name']}:{row_index + 1}:{col_index + 1}:client",
                            "month": sheet["name"],
                            "row": row_index + 1,
                            "column": col_index + 1,
                            "label": cell_text,
                            "name": name,
                            "type": event_type,
                            "amount": get_amount_near_label(row, col_index),
                            "description": description,
                            "contextTexts": context_texts,
                        }
                    )
                    continue

                associate_match = re.match(r"^Associ[eé]\s*-\s*(.+)$", cell_text, flags=re.IGNORECASE)
                if associate_match:
                    name = associate_match.group(1).strip()
                    context_texts = get_context_texts(rows, row_index, col_index)
                    description = best_description(cell_text, context_texts)
                    associate_events.append(
                        {
                            "sourceId": f"{sheet['name']}:{row_index + 1}:{col_index + 1}:associate",
                            "month": sheet["name"],
                            "row": row_index + 1,
                            "column": col_index + 1,
                            "label": cell_text,
                            "name": name,
                            "amount": get_amount_near_label(row, col_index),
                            "description": description,
                            "contextTexts": context_texts,
                        }
                    )

    for event in client_events:
        event["projectKey"] = project_key_for_event(event)
    for event in associate_events:
        event["projectKey"] = project_key_for_event(event)

    return client_events, associate_events


def token_set(value: str):
    return {token for token in clean_project_text(value, "").split(" ") if token and len(token) > 2}


def intersection_size(left, right) -> int:
    return sum(1 for token in left if token in right)


def link_associate_events(client_events, associate_events):
    client_tokens = {}
    for event in client_events:
        client_tokens[event["sourceId"]] = token_set(event["description"])
        event["linkedAssociateEvents"] = []

    for associate in associate_events:
        associate_tokens = token_set(associate["description"])
        best_client = None
        best_score = float("-inf")

        for client in client_events:
            if client["month"] != associate["month"]:
                continue
            row_distance = abs(client["row"] - associate["row"])
            if row_distance > 35:
                continue

            overlap = intersection_size(client_tokens.get(client["sourceId"], set()), associate_tokens)
            mentions_client = normalize_text(client["name"]) in normalize_text(associate["description"])

            score = max(0, 35 - row_distance) + overlap * 10
            if mentions_client:
                score += 15
            if associate["projectKey"] == client["projectKey"]:
                score += 25

            if score > best_score:
                best_score = score
                best_client = client

        if best_client is not None and best_score >= 20:
            best_client["linkedAssociateEvents"].append(associate)


def build_commission(event, index: int):
    linked_agents = unique([item["name"] for item in event.get("linkedAssociateEvents", [])])
    distribution = {}

    for associate in event.get("linkedAssociateEvents", []):
        distribution.setdefault(
            associate["name"],
            {"amount": 0, "percent": 0, "paid": True},
        )
        distribution[associate["name"]]["amount"] += associate.get("amount", 0) or 0

    build_base = event.get("description") or event["label"]
    build_name = f"{build_base}{' [Acompte]' if event['type'] == 'deposit' else ''}".strip()
    world_name = f"c-import-{slugify(event.get('name') or 'commission')}-{slugify(event['month'])}-{str(index + 1).zfill(3)}"

    notes = [
        "Import historique depuis Comptabilité Lusciana.xlsx",
        f"Mois: {event['month']}",
        f"Ligne source: {event['row']}",
        f"Type source: {event['type']}",
        f"Libelle: {event['label']}",
        f"Description: {event.get('description') or 'N/A'}",
    ]
    if linked_agents:
        notes.append(f"Associes detectes: {', '.join(linked_agents)}")

    now = iso_now()
    return {
        "legacySourceId": event["sourceId"],
        "buildSize": "legacy-import",
        "buildName": build_name,
        "worldName": world_name,
        "realizedBy": linked_agents,
        "version": "",
        "forCustomer": "yes",
        "price": event.get("amount", 0) or 0,
        "buildStart": "",
        "buildEnd": "",
        "depositPaid": "yes" if event["type"] == "deposit" else "no",
        "depositAmount": (event.get("amount", 0) or 0) if event["type"] == "deposit" else 0,
        "buildType": "legacy",
        "organics": "",
        "selectedAgents": linked_agents,
        "priceDistribution": distribution,
        "commissionPercent": 0,
        "wentWell": "yes",
        "clientName": event["name"],
        "clientWants": "\n".join(notes),
        "hasFeedback": "no",
        "clientFeedback": "",
        "render": "",
        "showcaseText": "",
        "createdBy": "legacy-import",
        "createdAt": now,
        "updatedAt": now,
        "legacyImport": {
            "source": "Comptabilité Lusciana.xlsx",
            "month": event["month"],
            "row": event["row"],
            "column": event["column"],
            "type": event["type"],
            "label": event["label"],
            "description": event.get("description"),
            "contextTexts": event.get("contextTexts", []),
            "linkedAssociateEvents": [
                {
                    "sourceId": item["sourceId"],
                    "name": item["name"],
                    "amount": item.get("amount"),
                    "label": item["label"],
                    "description": item.get("description"),
                    "row": item["row"],
                }
                for item in event.get("linkedAssociateEvents", [])
            ],
        },
    }


def build_preview(workbook):
    agent_data = extract_agents(workbook)
    client_events, associate_events = scan_events(workbook)
    link_associate_events(client_events, associate_events)
    commissions = [build_commission(event, index) for index, event in enumerate(client_events)]

    return {
        "generatedAt": iso_now(),
        "sourceWorkbook": workbook.get("workbook"),
        "summary": {
            "agentCount": len(agent_data["items"]),
            "clientAgentCount": len(agent_data["clients"]),
            "builderAgentCount": len(agent_data["associates"]),
            "supplierCount": len(agent_data["suppliers"]),
            "commissionCount": len(commissions),
            "clientEventCount": len(client_events),
            "associateEventCount": len(associate_events),
        },
        "agents": agent_data["items"],
        "commissions": commissions,
        "warnings": [
            "Les commissions importees correspondent aux evenements comptables client (acompte/facture), pas a un regroupement manuel projet par projet.",
            "Les roles manager/builder ne sont pas explicitement presents dans le classeur: tous les associes sont importes en builder par defaut.",
            "Les paiements fournisseurs ne sont pas importes comme agents, mais restent visibles dans les donnees sources du classeur.",
        ],
    }


def parse_env_file(file_path: Path) -> dict:
    values = {}
    if not file_path.exists():
        return values

    with file_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def write_to_mongo(preview):
    try:
        from pymongo import MongoClient
    except ImportError as exc:
        raise RuntimeError("Le module Python 'pymongo' est requis pour --write. Installe-le avec: python3 -m pip install --user pymongo") from exc

    env = parse_env_file(BACKEND_DIR / ".env")
    mongodb_uri = env.get("MONGODB_URI")
    database_name = env.get("MONGODB_DATABASE", "lusciana")

    if not mongodb_uri:
        raise RuntimeError("Impossible de lire MONGODB_URI dans backend/.env")

    client = MongoClient(mongodb_uri)
    database = client[database_name]
    agents = database["agents"]
    commissions = database["commissions"]

    try:
        for agent in preview["agents"]:
            existing = agents.find_one({"pseudo": agent["pseudo"]})
            if existing:
                agents.update_one(
                    {"_id": existing["_id"]},
                    {
                        "$set": {
                            "category": existing.get("category") or agent["category"],
                            "updatedAt": datetime.now(timezone.utc),
                            "legacyImport": {
                                **(existing.get("legacyImport") or {}),
                                **(agent.get("legacyImport") or {}),
                            },
                        }
                    },
                )
            else:
                document = dict(agent)
                document["createdAt"] = datetime.fromisoformat(agent["createdAt"].replace("Z", "+00:00"))
                document["updatedAt"] = datetime.fromisoformat(agent["updatedAt"].replace("Z", "+00:00"))
                agents.insert_one(document)

        for commission in preview["commissions"]:
            query = {
                "legacyImport.source": "Comptabilité Lusciana.xlsx",
                "legacyImport.month": commission["legacyImport"]["month"],
                "legacyImport.row": commission["legacyImport"]["row"],
                "legacyImport.column": commission["legacyImport"]["column"],
                "legacyImport.type": commission["legacyImport"]["type"],
            }
            document = dict(commission)
            document["createdAt"] = datetime.fromisoformat(commission["createdAt"].replace("Z", "+00:00"))
            document["updatedAt"] = datetime.fromisoformat(commission["updatedAt"].replace("Z", "+00:00"))
            commissions.update_one(query, {"$set": document}, upsert=True)
    finally:
        client.close()


def main() -> int:
    args = parse_args()
    source = Path(args.source)
    workbook_json = Path(args.workbook_json)
    output = Path(args.output)

    export_workbook(source, workbook_json)
    workbook = read_json(workbook_json)
    preview = build_preview(workbook)

    ensure_directory(output)
    with output.open("w", encoding="utf-8") as handle:
        json.dump(preview, handle, ensure_ascii=False, indent=2)

    if args.write:
        write_to_mongo(preview)

    payload = {
        "output": str(output),
        "summary": preview["summary"],
        "write": args.write,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
