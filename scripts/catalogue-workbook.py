"""Builds data/catalogue.xlsx, a filterable view of the whole catalogue (T3.2).

    npm run catalogue:workbook

Reads data/services.v2.json (imported and synthetic services) and
data/sources/third-party-to-verify.csv (rows awaiting a person's check). The workbook is a
view: the JSON and the CSV stay the sources of truth, and ingestion reads only those.

Sheets
  All services  every service, one row each, filter on every column, sorted by topic
                then provider group; colour shows the status
  By topic      count of services per topic and provider group
  To verify     the sheet rows in ingestion column order (edit here, then save as CSV)
  Synthetic     the original made-up services, kept apart
"""
import csv
import json
from collections import Counter
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "data" / "services.v2.json"
SHEET = ROOT / "data" / "sources" / "third-party-to-verify.csv"
OUT = ROOT / "data" / "catalogue.xlsx"

STATUS_LIVE = "Live price (imported)"
STATUS_CHECKED = "Checked on pricing page"
STATUS_VERIFY = "To verify"
STATUS_SYNTH = "Synthetic (made up)"
FILL = {
    STATUS_LIVE: PatternFill("solid", fgColor="E2F0D9"),
    STATUS_CHECKED: PatternFill("solid", fgColor="DDEBF7"),
    STATUS_VERIFY: PatternFill("solid", fgColor="FFF2CC"),
    STATUS_SYNTH: PatternFill("solid", fgColor="D9D9D9"),
}
HEADER_FILL = PatternFill("solid", fgColor="1F3864")
HEADER_FONT = Font(bold=True, color="FFFFFF")
GROUPS = ["AWS", "Azure", "Google Cloud", "Third-party", "Synthetic"]


def provider_group(provider: str, synthetic: bool) -> str:
    if synthetic:
        return "Synthetic"
    p = provider.lower()
    if "amazon" in p:
        return "AWS"
    if "microsoft" in p or "azure" in p:
        return "Azure"
    if p.startswith("google") or "(google)" in p:
        return "Google Cloud"
    return "Third-party"


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return v


def rows():
    out = []
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    in_catalogue = {s["serviceId"] for s in catalogue}
    for s in catalogue:
        synth = bool(s.get("synthetic"))
        fed = "official public price feed" in s["source"].get("terms", "")
        out.append({
            "Status": STATUS_SYNTH if synth else STATUS_LIVE if fed else STATUS_CHECKED,
            "Topic": s["capability"],
            "Provider group": provider_group(s["provider"], synth),
            "Provider": s["provider"],
            "Service": s["name"],
            "Service ID": s["serviceId"],
            "Price": s["pricing"]["amount"],
            "Unit": s["pricing"]["unit"],
            "Currency": s["pricing"]["currency"],
            "Uptime %": s.get("measured", {}).get("uptime", s["advertised"]["uptime"]),
            "Source": s["source"]["url"],
            "Retrieved": s["source"]["retrievedAt"],
            "Notes": s["pricing"].get("notes", ""),
            "Description": s["description"],
        })
    with SHEET.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["serviceId"] in in_catalogue:
                continue  # already verified and ingested; shown from the catalogue
            out.append({
                "Status": STATUS_VERIFY,
                "Topic": r["capability"],
                "Provider group": provider_group(r["provider"], False),
                "Provider": r["provider"],
                "Service": r["name"],
                "Service ID": r["serviceId"],
                "Price": num(r["price"]),
                "Unit": r["priceUnit"],
                "Currency": r["currency"],
                "Uptime %": num(r["uptime"]),
                "Source": r["sourceUrl"],
                "Retrieved": r["retrievedAt"],
                "Notes": r["priceNotes"],
                "Description": r["description"],
            })
    order = {g: i for i, g in enumerate(GROUPS)}
    out.sort(key=lambda r: (r["Topic"], order[r["Provider group"]], r["Service"].lower()))
    return out


def write_table(ws, header, data, widths, fill_by=None, link_col=None):
    ws.append(header)
    for c in ws[1]:
        c.fill, c.font = HEADER_FILL, HEADER_FONT
        c.alignment = Alignment(vertical="center")
    for r in data:
        ws.append([r[h] for h in header])
        if fill_by:
            for c in ws[ws.max_row]:
                c.fill = FILL[r[fill_by]]
        if link_col and str(r[link_col]).startswith("https://"):
            cell = ws.cell(row=ws.max_row, column=header.index(link_col) + 1)
            cell.hyperlink, cell.style = r[link_col], "Hyperlink"
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions


def main():
    data = rows()
    wb = Workbook()

    ws = wb.active
    ws.title = "All services"
    header = list(data[0].keys())
    write_table(ws, header, data, [20, 22, 14, 24, 36, 30, 10, 30, 9, 9, 40, 11, 40, 60], fill_by="Status", link_col="Source")

    ws = wb.create_sheet("By topic")
    counts = Counter((r["Topic"], r["Provider group"]) for r in data)
    topics = sorted({r["Topic"] for r in data})
    table = [{"Topic": t, **{g: counts[(t, g)] for g in GROUPS}, "Real total": sum(counts[(t, g)] for g in GROUPS[:4])} for t in topics]
    write_table(ws, ["Topic", *GROUPS, "Real total"], table, [24, 8, 8, 14, 12, 11, 11])
    ws.append(["Total", *[sum(t[g] for t in table) for g in GROUPS], sum(t["Real total"] for t in table)])
    for c in ws[ws.max_row]:
        c.font = Font(bold=True)
    ws.auto_filter.ref = f"A1:{get_column_letter(len(GROUPS) + 2)}{len(table) + 1}"

    ws = wb.create_sheet("To verify")
    with SHEET.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        sheet_rows = sorted(reader, key=lambda r: (r["capability"], r["provider"].lower()))
        cols = reader.fieldnames
    write_table(ws, cols, sheet_rows, [28, 30, 20, 50, 20, 34, 9, 26, 9, 34, 8, 9, 40, 12, 18], link_col="sourceUrl")

    ws = wb.create_sheet("Synthetic")
    synth = [r for r in data if r["Status"] == STATUS_SYNTH]
    write_table(ws, header, synth, [20, 22, 14, 24, 36, 30, 10, 30, 9, 9, 40, 11, 40, 60], fill_by="Status")

    ws = wb.create_sheet("Key")
    for line in [
        ["Colour", "Status", "Meaning"],
        ["green", STATUS_LIVE, "Price read today from the provider's official price feed (AWS, Azure, Google)."],
        ["blue", STATUS_CHECKED, "Price read from the provider's pricing page on the Retrieved date."],
        ["yellow", STATUS_VERIFY, "Pre-filled from memory; the page could not be read automatically. Check against Source, fill retrievedAt, then ingest."],
        ["grey", STATUS_SYNTH, "The original invented services (example.com endpoints), kept for tests only."],
        [],
        ["Uptime is the provider's advertised SLA until measured probes (T3.3) replace it."],
        ["Units differ between providers; compare prices only within the same unit until T3.4."],
        ["To feed edits back: edit the 'To verify' sheet, save it as CSV over data/sources/third-party-to-verify.csv."],
    ]:
        ws.append(line)
    for c, s in zip(ws["A"][1:5], [STATUS_LIVE, STATUS_CHECKED, STATUS_VERIFY, STATUS_SYNTH]):
        c.fill = FILL[s]
    ws["A1"].font = ws["B1"].font = ws["C1"].font = Font(bold=True)
    ws.column_dimensions["A"].width, ws.column_dimensions["B"].width, ws.column_dimensions["C"].width = 10, 24, 90

    wb.save(OUT)
    by = Counter(r["Status"] for r in data)
    print(f"Wrote {OUT} with {len(data)} services: " + ", ".join(f"{v} {k}" for k, v in by.items()))


if __name__ == "__main__":
    main()
