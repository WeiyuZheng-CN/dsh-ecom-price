#!/usr/bin/env python
"""Merge scrape results into a checkable workbook with clickable links.

Reads items.json (from build_items.py) plus any number of result files produced
by scrape-tb.mjs / scrape-jd.mjs, and writes one row per item.

  python make_report.py --items items.json \
      --results tb-results.json tb2-results.json jd-results.json \
      --out 比价表.xlsx [--marks 原始清单.xlsx]

Later --results files win when the same id appears twice.
"""
import argparse
import json
import os

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HEAD = PatternFill("solid", fgColor="FF2F4F4F")
HEAD_FONT = Font(bold=True, color="FFFFFFFF", size=10.5, name="微软雅黑")
BASE = Font(size=10, name="微软雅黑")
LINK = Font(size=10, name="微软雅黑", color="FF0563C1", underline="single")
GREY = Font(size=9, name="微软雅黑", color="FF666666")
YELLOW = PatternFill("solid", fgColor="FFFFF3B0")
RED = PatternFill("solid", fgColor="FFFFC7CE")
THIN = Side(style="thin", color="FFD9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

LABEL = {"MERGE": "可精简", "FALLBACK": "备预案", "CONDITIONAL": "看情况", "SPEC": "型号问题"}


def first_price(s):
    """'39.9' / '39.9-45' / '¥39.90' -> float"""
    if s is None:
        return None
    txt = str(s).replace("¥", "").replace("￥", "").strip()
    head = txt.split("-")[0].strip()
    try:
        return float(head)
    except ValueError:
        return None


def from_result(rec):
    """Normalise one scrape record into (unit, shop, title, link, platform, status)."""
    if not rec:
        return None, None, None, None, None, "missing"
    status = rec.get("status")
    detail = rec.get("detail") or {}
    if detail.get("price"):
        return (
            first_price(detail.get("price")),
            detail.get("shop") or rec.get("shop"),
            detail.get("title") or detail.get("listTitle"),
            detail.get("link"),
            "淘宝",
            status,
        )
    items = rec.get("items") or []
    if items:
        c = items[0]
        return first_price(c.get("price")), c.get("shop"), c.get("name"), c.get("link"), "京东", status
    return None, None, None, None, None, status or "no-price"


def read_marks(path):
    """Font/fill legend: yellow fill=可精简, red fill=备预案, red text=看情况, theme3 text=型号问题."""
    if not path or not os.path.exists(path):
        return {}
    wb = load_workbook(path)
    ws = wb.worksheets[0]
    marks = {}
    for row in range(1, ws.max_row + 1):
        idx = ws.cell(row, 1).value
        if not isinstance(idx, int):
            continue
        codes = []
        for ci in (3, 4):
            c = ws.cell(row, ci)
            col = c.font.color
            rgb = col.rgb if col is not None and col.type == "rgb" else None
            theme = col.theme if col is not None and col.type == "theme" else None
            fill = c.fill.fgColor.rgb if c.fill and c.fill.fgColor and c.fill.fgColor.type == "rgb" else None
            if fill and str(fill).upper().endswith("FFFF00"):
                codes.append("MERGE")
            if fill and str(fill).upper().endswith("FF0000"):
                codes.append("FALLBACK")
            if rgb and str(rgb).upper().endswith("FF0000"):
                codes.append("CONDITIONAL")
            if theme == 3:
                codes.append("SPEC")
        if codes:
            marks[idx] = list(dict.fromkeys(codes))
    return marks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", required=True)
    ap.add_argument("--results", nargs="+", required=True)
    ap.add_argument("--marks", default=None)
    ap.add_argument("--out", default="比价表.xlsx")
    args = ap.parse_args()

    items = json.load(open(args.items, encoding="utf-8"))
    merged = {}
    for path in args.results:
        if not os.path.exists(path):
            print("skip missing:", path)
            continue
        data = json.load(open(path, encoding="utf-8"))
        for key, rec in data.items():
            cur = merged.get(key)
            new_priced = from_result(rec)[0] is not None
            cur_priced = cur is not None and from_result(cur)[0] is not None
            # keep a record that carries a price; only overwrite it with another priced one
            if new_priced or not cur_priced:
                merged[key] = rec
    marks = read_marks(args.marks)

    wb = Workbook()
    ws = wb.active
    ws.title = "比价"
    headers = ["序号", "物品", "规格", "数量", "参考单价", "参考小计", "实价", "小计",
               "价差", "店铺", "平台", "链接", "状态", "标注"]
    widths = [6, 22, 24, 6, 9, 9, 9, 9, 8, 20, 8, 12, 11, 10]
    ws.append(headers)
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in ws[1]:
        c.fill = HEAD
        c.font = HEAD_FONT
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = BORDER

    ref_total = priced_total = 0.0
    r = 2
    for it in items:
        rec = merged.get(str(it["id"]))
        unit, shop, title, link, platform, status = from_result(rec)
        qty = it.get("qty") if isinstance(it.get("qty"), (int, float)) else 1
        ref = it.get("refPrice")
        ref_sub = round(ref * qty, 2) if ref else None
        sub = round(unit * qty, 2) if unit is not None else None
        diff = round(sub - ref_sub, 2) if (sub is not None and ref_sub) else None
        ref_total += ref_sub or 0
        priced_total += sub or 0

        ws.append([it["id"], it.get("name"), it.get("spec"), it.get("qty"), ref, ref_sub,
                   unit, sub, diff, shop, platform, None, status, " ".join(LABEL.get(c, c) for c in marks.get(it["id"], []))])
        for c in ws[r]:
            c.font = BASE
            c.border = BORDER
            c.alignment = Alignment(vertical="top", wrap_text=c.column in (3, 10))
        for col in (5, 6, 7, 8, 9):
            ws.cell(r, col).number_format = "0.00"
        if link:
            cell = ws.cell(r, 12, "打开")
            cell.hyperlink = link
            cell.font = LINK
            cell.alignment = Alignment(horizontal="center", vertical="top")
        if status and status != "ok":
            ws.cell(r, 13).font = Font(size=10, name="微软雅黑", color="FFC00000")
        codes = marks.get(it["id"], [])
        if "MERGE" in codes:
            ws.cell(r, 2).fill = YELLOW
        if "FALLBACK" in codes:
            ws.cell(r, 2).fill = RED
        if "CONDITIONAL" in codes:
            ws.cell(r, 2).font = Font(size=10, name="微软雅黑", color="FFC00000")
        r += 1

    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:N{r - 1}"

    r += 1
    for label, val, note in [
        ("清单参考总价", round(ref_total, 2), "按数量折算"),
        ("已取到实价合计", round(priced_total, 2), "只统计拿到价格的项"),
        ("差额", round(priced_total - ref_total, 2), "正数=比原估价贵"),
    ]:
        ws.cell(r, 1, label).font = Font(bold=True, size=10, name="微软雅黑")
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
        c = ws.cell(r, 4, val)
        c.font = Font(bold=True, size=10, name="微软雅黑")
        c.number_format = "0.00"
        ws.cell(r, 5, note).font = GREY
        r += 1

    wb.create_sheet("说明").append(["用法", "cdp.mjs 驱动浏览器取数 → make_report.py 出表；链接列可点开核对"])
    wb.save(args.out)
    ok = sum(1 for it in items if from_result(merged.get(str(it["id"])))[0] is not None)
    print(f"saved {args.out}  rows={len(items)}  priced={ok}  ref={ref_total:.2f}  priced_total={priced_total:.2f}")


if __name__ == "__main__":
    main()
