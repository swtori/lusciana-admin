#!/usr/bin/env python3

import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def cell_to_indices(reference: str) -> tuple[int, int]:
    letters = "".join(ch for ch in reference if ch.isalpha())
    numbers = "".join(ch for ch in reference if ch.isdigit())
    col = 0
    for letter in letters:
        col = col * 26 + (ord(letter.upper()) - ord("A") + 1)
    row = int(numbers) if numbers else 0
    return row, col


def parse_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        xml_bytes = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []

    root = ET.fromstring(xml_bytes)
    values: list[str] = []
    for si in root.findall(f"{NS_MAIN}si"):
        text_node = si.find(f"{NS_MAIN}t")
        if text_node is not None and text_node.text is not None:
            values.append(text_node.text)
            continue

        rich_parts = []
        for rich in si.findall(f"{NS_MAIN}r"):
            rich_text = rich.find(f"{NS_MAIN}t")
            if rich_text is not None and rich_text.text is not None:
                rich_parts.append(rich_text.text)
        values.append("".join(rich_parts))

    return values


def parse_relationships(archive: zipfile.ZipFile) -> dict[str, str]:
    xml_bytes = archive.read("xl/_rels/workbook.xml.rels")
    root = ET.fromstring(xml_bytes)
    relations: dict[str, str] = {}
    for rel in root.findall(f"{NS_REL}Relationship"):
        rel_id = rel.attrib.get("Id", "")
        target = rel.attrib.get("Target", "")
        if rel_id and target:
            relations[rel_id] = target
    return relations


def cell_value(cell: ET.Element, shared_strings: list[str]):
    cell_type = cell.attrib.get("t", "")

    if cell_type == "inlineStr":
        inline = cell.find(f"{NS_MAIN}is/{NS_MAIN}t")
        if inline is not None and inline.text is not None:
            return inline.text

        rich_parts = [
            node.text or ""
            for node in cell.findall(f"{NS_MAIN}is/{NS_MAIN}r/{NS_MAIN}t")
        ]
        return "".join(rich_parts)

    value_node = cell.find(f"{NS_MAIN}v")
    if value_node is None or value_node.text is None:
        return None

    raw = value_node.text
    if cell_type == "s":
        index = int(raw)
        return shared_strings[index] if 0 <= index < len(shared_strings) else ""

    if cell_type == "b":
        return raw == "1"

    try:
        number = float(raw)
        if number.is_integer():
            return int(number)
        return number
    except ValueError:
        return raw


def parse_sheet(archive: zipfile.ZipFile, sheet_path: str, shared_strings: list[str]) -> dict:
    xml_bytes = archive.read(sheet_path)
    root = ET.fromstring(xml_bytes)

    row_count = 0
    column_count = 0

    dimension = root.find(f"{NS_MAIN}dimension")
    if dimension is not None:
        dim_ref = dimension.attrib.get("ref", "")
        if ":" in dim_ref:
            _, end_ref = dim_ref.split(":", 1)
            row_count, column_count = cell_to_indices(end_ref)

    rows_by_index: dict[int, dict[int, object]] = {}
    sheet_data = root.find(f"{NS_MAIN}sheetData")
    if sheet_data is not None:
        for row in sheet_data.findall(f"{NS_MAIN}row"):
            row_index = int(row.attrib.get("r", "0"))
            row_map: dict[int, object] = {}
            for cell in row.findall(f"{NS_MAIN}c"):
                reference = cell.attrib.get("r", "")
                _, col_index = cell_to_indices(reference)
                row_map[col_index] = cell_value(cell, shared_strings)
                column_count = max(column_count, col_index)
            rows_by_index[row_index] = row_map
            row_count = max(row_count, row_index)

    rows: list[list[object]] = []
    for row_index in range(1, row_count + 1):
        row_map = rows_by_index.get(row_index, {})
        rows.append([row_map.get(col_index) for col_index in range(1, column_count + 1)])

    return {
        "rowCount": row_count,
        "columnCount": column_count,
        "rows": rows,
    }


def export_workbook(workbook_path: str, output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with zipfile.ZipFile(workbook_path, "r") as archive:
        workbook_xml = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = parse_relationships(archive)
        shared_strings = parse_shared_strings(archive)

        sheets = []
        sheets_node = workbook_xml.find(f"{NS_MAIN}sheets")
        if sheets_node is not None:
            for sheet in sheets_node.findall(f"{NS_MAIN}sheet"):
                name = sheet.attrib.get("name", "")
                rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", "")
                target = relationships.get(rel_id)
                if not target:
                    continue

                sheet_path = "xl/" + target.replace("\\", "/")
                parsed = parse_sheet(archive, sheet_path, shared_strings)
                sheets.append(
                    {
                        "name": name,
                        "rowCount": parsed["rowCount"],
                        "columnCount": parsed["columnCount"],
                        "rows": parsed["rows"],
                    }
                )

    payload = {
        "workbook": os.path.basename(workbook_path),
        "sheets": sheets,
    }

    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("Usage: export-lusciana-workbook.py <workbook_path> <output_path>\n")
        return 1

    export_workbook(sys.argv[1], sys.argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
