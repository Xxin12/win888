#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
解析 TDX 通达信 1 分钟 K 线 MCP 结果文件(tool-results/*.txt)，落盘为项目分时 CSV。

输出格式(与腾讯分时落盘一致): data/intraday/{code}_{YYYY-MM-DD}.csv
  列: time,price,avg,volume,cum_volume
    time        HH:MM (来自 Second 距零点秒数)
    price       该分钟收盘价 Close
    avg         日内累计 VWAP = 累计成交额 / (累计成交量(手)*100)
    volume      该分钟成交量(手)  —— 单根增量
    cum_volume  累计成交量(手)

用法:
  python parse_tdx_intraday.py <results_dir> [--out <intraday_dir>] [--dry]
若省略 results_dir，默认读取脚本同级的 tool-results 目录(由调用方传入绝对路径)。
"""
import json
import os
import re
import sys
import glob

DEFAULT_RESULTS = r"C:\Users\miao\.workbuddy\projects\c-Users-miao-Desktop-W888\f06e8d23-9948-4742-9fa2-b4820e999e09\tool-results"
DEFAULT_OUT = r"C:\Users\miao\Desktop\W888\quant-web\data\intraday"


def parse_file(path):
    """返回 (code, rows) 或 (None, [])。rows: list of dict(code,date,sec,t,price,vol_hands,amt)"""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except Exception as e:
        print(f"  [skip] 读取失败 {os.path.basename(path)}: {e}")
        return None, []
    s = text.find("{")
    e = text.rfind("}")
    if s < 0 or e < 0 or e <= s:
        # 可能没有 JSON(纯文本错误), 跳过
        return None, []
    try:
        obj = json.loads(text[s:e + 1])
    except Exception as ex:
        print(f"  [skip] JSON 解析失败 {os.path.basename(path)}: {ex}")
        return None, []
    code = str(obj.get("Code", "")).strip()
    rows = obj.get("Rows", [])
    if not code or not rows:
        return None, []
    out = []
    for r in rows:
        try:
            date = str(r["Data"]).strip()           # YYYYMMDD
            sec = int(float(r["Second"]))            # 距零点秒数
            total_min = sec // 60
            hh = total_min // 60
            mm = total_min % 60
            t = f"{hh:02d}:{mm:02d}"
            price = float(r["Close"])
            # Volume 为手(100股); RawVolume = Volume*100 即股数
            vol_hands = float(r.get("Volume", 0) or 0)
            amt = float(r.get("Amount", 0) or 0)
            out.append({
                "code": code, "date": date, "sec": sec, "t": t,
                "price": price, "vol_hands": vol_hands, "amt": amt,
            })
        except Exception:
            continue
    return code, out


def build_csv_rows(day_rows):
    """day_rows: 同一天、已按 sec 排序的列表。计算累计量与 VWAP。
    注意: TDX 连接器/节点返回的成交量单位可能不一致(手 vs 股), 不能写死。
    用 成交额 ≈ 现价 × 成交量 的关系逐日判定单位并归一为手(lots);
    若判定为股(shares)则成交量 ÷100。均价(VWAP)=累计额/(累计量×100)。
    """
    # 逐日判定成交量单位
    ratios = []
    for r in day_rows:
        p = r["price"]
        v = r["vol_hands"]
        a = r["amt"]
        if p > 0 and v > 0 and a > 0:
            ratios.append(a / (p * v))  # ≈1 表示股(shares); ≈100 表示手(lots)
    unit = "lots"
    if ratios:
        ratios.sort()
        med = ratios[len(ratios) // 2]
        unit = "shares" if med < 10 else "lots"
    factor = 0.01 if unit == "shares" else 1.0
    cum_vol = 0.0
    cum_amt = 0.0
    res = []
    for r in day_rows:
        v = r["vol_hands"] * factor  # 归一为手
        cum_vol += v
        cum_amt += r["amt"]
        avg = (cum_amt / (cum_vol * 100)) if cum_vol > 0 else r["price"]
        avg = round(avg, 3)
        res.append({
            "t": r["t"],
            "price": round(r["price"], 3),
            "avg": avg,
            "volume": round(v, 2),
            "cum_volume": round(cum_vol, 2),
        })
    return res


def main():
    args = sys.argv[1:]
    results_dir = DEFAULT_RESULTS
    out_dir = DEFAULT_OUT
    dry = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--out":
            out_dir = args[i + 1]; i += 2
        elif a == "--dry":
            dry = True; i += 1
        elif a.startswith("--"):
            i += 1
        else:
            results_dir = a; i += 1
    files = sorted(glob.glob(os.path.join(results_dir, "*tdx_kline*.txt")))
    print(f"结果目录: {results_dir}")
    print(f"找到 {len(files)} 个 TDX 结果文件")
    if not files:
        return

    by_code = {}   # code -> list of row dicts
    skipped = 0
    for fp in files:
        code, rows = parse_file(fp)
        if not code:
            skipped += 1
            continue
        by_code.setdefault(code, []).extend(rows)

    print(f"解析得到股票: {list(by_code.keys())}; 跳过文件: {skipped}")

    summary = []
    for code, rows in by_code.items():
        # 去重 + 排序
        seen = set()
        uniq = []
        for r in rows:
            key = (r["date"], r["sec"])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(r)
        uniq.sort(key=lambda x: (x["date"], x["sec"]))

        # 按日分组
        by_day = {}
        for r in uniq:
            by_day.setdefault(r["date"], []).append(r)
        for d in by_day:
            by_day[d].sort(key=lambda x: x["sec"])

        dates = sorted(by_day.keys())
        if not dry:
            os.makedirs(out_dir, exist_ok=True)
        written = 0
        day_info = []
        for d in dates:
            dr = build_csv_csv(by_day[d])
            day_info.append((d, len(dr), dr[-1]["cum_volume"] if dr else 0))
            if not dry:
                fn = os.path.join(out_dir, f"{code}_{d[:4]}-{d[4:6]}-{d[6:8]}.csv")
                with open(fn, "w", encoding="utf-8", newline="") as f:
                    f.write("time,price,avg,volume,cum_volume\n")
                    for row in dr:
                        f.write(f"{row['t']},{row['price']},{row['avg']},{row['volume']},{row['cum_volume']}\n")
                written += 1
        summary.append((code, len(dates), dates[0], dates[-1], written, day_info))
        print(f"\n=== {code} === 交易日数={len(dates)} 区间 {dates[0]}~{dates[-1]} 写入CSV={written}")
        # 打印前3天与后3天信息
        for d, n, cv in day_info[:3] + day_info[-3:]:
            print(f"    {d}: 根数={n} 收盘累计手数={cv:.0f}")

    print("\n[汇总]")
    for code, ndays, d0, d1, w, _ in summary:
        print(f"  {code}: {ndays} 交易日, {d0}~{d1}, CSV={w}")


def build_csv_csv(day_rows):
    """包装 build_csv_rows 以便复用(避免命名冲突)"""
    return build_csv_rows(day_rows)


if __name__ == "__main__":
    main()
