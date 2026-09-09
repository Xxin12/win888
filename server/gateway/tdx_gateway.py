# -*- coding: utf-8 -*-
"""
TDX 独立行情网关 (standalone, 完全脱离 WorkBuddy)
=================================================

作用
----
quant-web 的 server/providers/tdx_intraday.js 通过 HTTP 调用本网关拉 1 分钟分时;
本网关用 pytdx(社区事实标准, 非官方) 直连"公共行情服务器"取数, 再翻译成 quant-web
约定的 JSON。整条链路不依赖 WorkBuddy 连接器 / MCP。

对外契约 (与 tdx_intraday.js 对齐)
---------------------------------
GET /kline?code=600031&setcode=1&period=7&startxh=0&wantNum=1000&tqFlag=1
    Header: Authorization: Bearer <TDX_TOKEN>   (设置了 TDX_TOKEN 时必带)
    成功: { "ok": true,  "rows": [ { "time":"YYYY-MM-DD HH:MM",
                                     "open": <开>, "high": <高>, "low": <低>, "close": <收>,
                                     "price": <close, 向后兼容分时累计>,
                                     "volume": <每根成交量·手>,
                                     "amount": <每根成交额·元> } ] }
    失败: { "ok": false, "reason": "..." }

    取 K 线(日线/5分钟)时直接传 category(绕过 period 默认1分钟):
      category=4 -> 日线;  category=0 -> 5分钟;  category=8/period=7 -> 1分钟(分时)
      行结构含完整 open/high/low/close, 供客户端拼 K 线。

    说明: 网关只返回"每根原始量/额"(raw per-bar), 不算累计。
          日累计量(cumVolume) 与 日均价(avg=amount/(vol*100)) 由 client 收齐所有分页、
          排序去重后按日累加得到 —— 避免分页窗口切在日内导致累计错乱。

GET /healthz  ->  { "ok": true, "connected": <bool>, "host": "ip:port" }

频率限制 (第二层, 本网关是 TDX 唯一出口, 防限流封号的关键)
--------------------------------------------------------
  1. 串行访问: 全局锁保证任一时刻只有一个 pytdx 请求在飞 (无并发)。
  2. 请求节流: 相邻两次 get_security_bars 至少间隔 TDX_REQUEST_GAP_MS (默认 400ms)。
  3. 失败退避: 连接/取数失败指数退避 (1s,2s,4s...), 最多 TDX_MAX_RETRY 次。
  4. 响应缓存: 历史 1 分钟数据不可变, 按 (market,code,category,start,count) 缓存, 命中直接返回。
  5. 多节点故障切换: 内置公共节点列表, 某节点失败自动切下一个。
  6. 长连接复用: 一条 pytdx 连接贯穿多请求, 断线才重连 (重连最易被风控)。

环境变量 (全部可选, 均有默认值)
------------------------------
  PORT                 监听端口 (默认 8899)
  BIND                 监听地址 (默认 0.0.0.0, 局域网可达; 仅本机可设 127.0.0.1)
  TDX_TOKEN            Bearer token; 设置后所有 /kline 请求必须带 (默认空=不校验, 建议设)
  TDX_HOSTS            覆盖节点列表, 逗号分隔 "ip:port,ip:port" (默认用内置列表)
  TDX_REQUEST_GAP_MS   相邻 pytdx 请求最小间隔毫秒 (默认 400)
  TDX_MAX_RETRY        单次取数失败重试次数 (默认 3)
  TDX_CACHE_MAX        缓存条目上限 (默认 4000)

启动
----
  python -m venv .venv && . .venv\\Scripts\\activate   (Windows: .venv\\Scripts\\activate)
  pip install -r requirements.txt
  set TDX_TOKEN=your-secret   (Windows) / export TDX_TOKEN=your-secret
  python tdx_gateway.py
"""
import os
import time
import threading
import collections

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

try:
    from pytdx.hq import TdxHq_API
    from pytdx.params import TDXParams
except Exception as e:  # pytdx 未安装时给出清晰提示
    TdxHq_API = None
    TDXParams = None
    _IMPORT_ERR = str(e)
else:
    _IMPORT_ERR = None

# ------------------------------------------------------------------ 配置
PORT = int(os.environ.get("PORT", "8899"))
BIND = os.environ.get("BIND", "0.0.0.0")
TOKEN = os.environ.get("TDX_TOKEN", "").strip()
REQUEST_GAP_MS = int(os.environ.get("TDX_REQUEST_GAP_MS", "400"))
MAX_RETRY = int(os.environ.get("TDX_MAX_RETRY", "3"))
CACHE_MAX = int(os.environ.get("TDX_CACHE_MAX", "4000"))

# 公共行情服务器 (可用 TDX_HOSTS 覆盖)。免费公共节点会波动, 内置多个便于故障切换。
DEFAULT_HOSTS = [
    ("119.147.212.81", 7709),
    ("115.238.90.165", 7709),
    ("124.71.187.122", 7709),
    ("218.108.98.244", 7709),
    ("119.147.212.81", 7719),
    ("14.215.128.18", 7709),
]
if os.environ.get("TDX_HOSTS"):
    DEFAULT_HOSTS = []
    for part in os.environ["TDX_HOSTS"].split(","):
        part = part.strip()
        if not part:
            continue
        ip, _, port = part.partition(":")
        DEFAULT_HOSTS.append((ip.strip(), int(port or "7709")))

# pytdx K 线类别映射: TDX 协议类别代码
#   1分钟=8, 5分钟=0, 15分钟=1, 30分钟=2, 60分钟=3, 日线=4, 周线=5, 月线=6
# 我们契约里 period=7 沿用 agent 连接器口径, 在 pytdx 侧统一映射为 8(1分钟)。
# 现新增 category 直传参数, 客户端可直接传 4(日线)/0(5分钟) 取 K 线。
CATEGORY_1MIN = 8


# ------------------------------------------------------------------ 频控 + 连接管理
class TdxPool:
    """单连接 + 全局锁 + 节流 + 退避 + 故障切换 (线程安全)。"""

    def __init__(self, hosts):
        self.hosts = list(hosts)
        self.host_idx = 0
        self.api = None
        self.connected_host = None
        self.lock = threading.Lock()          # 串行化所有 pytdx 访问
        self._last_call_ts = 0.0               # 上次请求时刻 (节流用)

    def _cur_host(self):
        return self.hosts[self.host_idx % len(self.hosts)]

    def _next_host(self):
        self.host_idx = (self.host_idx + 1) % len(self.hosts)
        return self._cur_host()

    def _ensure_connected(self):
        if self.api is not None:
            return True
        if TdxHq_API is None:
            raise RuntimeError("pytdx 未安装: %s" % _IMPORT_ERR)
        # 依次尝试节点, 直到连上
        for _ in range(len(self.hosts)):
            ip, port = self._cur_host()
            api = TdxHq_API(heartbeat=True)
            try:
                if api.connect(ip, port, time_out=8):
                    self.api = api
                    self.connected_host = "%s:%d" % (ip, port)
                    return True
            except Exception:
                pass
            self._next_host()
        return False

    def _disconnect(self):
        try:
            if self.api is not None:
                self.api.disconnect()
        except Exception:
            pass
        self.api = None
        self.connected_host = None

    def _throttle(self):
        """相邻请求最小间隔 REQUEST_GAP_MS。"""
        gap = REQUEST_GAP_MS / 1000.0
        wait = gap - (time.time() - self._last_call_ts)
        if wait > 0:
            time.sleep(wait)

    def get_bars(self, category, market, code, start, count):
        """串行 + 节流 + 退避 + 故障切换地取一页 K 线。返回 list 或抛异常。"""
        with self.lock:
            last_err = None
            for attempt in range(MAX_RETRY + 1):
                self._throttle()
                try:
                    if not self._ensure_connected():
                        raise RuntimeError("所有节点均连接失败")
                    data = self.api.get_security_bars(category, market, code, start, count)
                    self._last_call_ts = time.time()
                    return data or []
                except Exception as e:
                    last_err = e
                    self._last_call_ts = time.time()
                    self._disconnect()          # 断线 -> 下次重连
                    self._next_host()           # 换节点
                    if attempt < MAX_RETRY:
                        time.sleep(1.0 * (2 ** attempt))  # 1s,2s,4s...
            raise RuntimeError("取数失败(已重试%d次): %s" % (MAX_RETRY, last_err))

    def health(self):
        return {"connected": self.api is not None, "host": self.connected_host}

    def security_count(self, market):
        """某市场证券(含股票/基金/债券/指数)总数。"""
        with self.lock:
            self._throttle()
            try:
                if not self._ensure_connected():
                    raise RuntimeError("所有节点均连接失败")
                n = self.api.get_security_count(market)
                self._last_call_ts = time.time()
                return int(n or 0)
            except Exception as e:
                self._last_call_ts = time.time()
                self._disconnect()
                self._next_host()
                raise

    def security_list(self, market, start, count):
        """分页取某市场证券列表(含 category/code/name/market); 用于枚举全市场股票池。"""
        with self.lock:
            self._throttle()
            try:
                if not self._ensure_connected():
                    raise RuntimeError("所有节点均连接失败")
                data = self.api.get_security_list(market, start, count)
                self._last_call_ts = time.time()
                return data or []
            except Exception as e:
                self._last_call_ts = time.time()
                self._disconnect()
                self._next_host()
                raise


POOL = TdxPool(DEFAULT_HOSTS)

# 简单 LRU 缓存: 历史 1 分钟数据不可变
_CACHE = collections.OrderedDict()
_CACHE_LOCK = threading.Lock()


def cache_get(key):
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    return None


def cache_put(key, val):
    with _CACHE_LOCK:
        _CACHE[key] = val
        _CACHE.move_to_end(key)
        while len(_CACHE) > CACHE_MAX:
            _CACHE.popitem(last=False)


# ------------------------------------------------------------------ 字段映射
def market_of(setcode):
    """setcode(沪1/深0/北8) -> pytdx market(SH1/SZ0/BJ2)。"""
    s = str(setcode)
    if s == "1":
        return 1          # 上海
    if s == "8":
        return 2          # 北交所 (实验性, pytdx 支持有限)
    return 0              # 深圳 (默认)


def prefix_of(code):
    """6 位代码 -> 市场前缀 sh/sz/bj (按 A股代码首位规则, 不依赖市场字段避免歧义)。"""
    c = str(code)[0] if code else ""
    if c in "69":
        return "sh"        # 600/601/603/605/688/689 沪市(含科创)
    if c == "8":
        return "bj"        # 8xxxxx 北交所
    return "sz"            # 000/001/002/003/30x 深市(含创业)


def bar_to_row(b):
    """pytdx bar -> 契约行 {time,open,high,low,close,price,volume,amount} (raw per-bar)。

    - 1 分钟分时: 消费方用 price/volume/amount 做累计均价;
    - 日K/5分钟: 消费方用 open/high/low/close/volume/amount 拼 K 线。
    两者共用同一结构, 向后兼容现有分时 provider。
    """
    dt = b.get("datetime") or ""
    # pytdx datetime 形如 '2026-07-14 15:00'(5分钟/1分钟) 或 '2026-07-15 00:00'(日线); 统一裁到分钟
    dt = str(dt)[:16]
    close = b.get("close")
    vol = b.get("vol", b.get("volume", 0))     # 成交量(手)
    amount = b.get("amount", 0)                 # 成交额(元)
    def f(x):
        return float(x) if x is not None else None
    return {
        "time": dt,
        "open": f(b.get("open")),
        "high": f(b.get("high")),
        "low": f(b.get("low")),
        "close": f(close),
        "price": f(close),                       # 向后兼容分时累计
        "volume": float(vol) if vol is not None else 0.0,
        "amount": float(amount) if amount is not None else 0.0,
    }


# ------------------------------------------------------------------ HTTP
app = FastAPI(title="TDX Gateway", docs_url=None, redoc_url=None)


def _auth_ok(request: Request):
    if not TOKEN:
        return True
    got = request.headers.get("authorization", "")
    if got.lower().startswith("bearer "):
        got = got[7:].strip()
    return got == TOKEN


@app.get("/healthz")
def healthz():
    h = POOL.health()
    return {"ok": True, "pytdx": TdxHq_API is not None, **h}


@app.get("/stocks")
def stocks(request: Request, limit: int = 0):
    """枚举全市场 A股股票池 (经 pytdx get_security_list, 过滤 category==1=股票)。

    枚举策略(两层):
      1) 主路径 get_security_list: 对 深圳(0)/上海(1)/北交(2) 市场按 get_security_count 分页拉取,
         取 category==1 的股票(含 code/name/market)。在能服务列表接口的节点(如本机可达的
         通达信节点)上可拿到全市场 code+name。
      2) 若某节点 get_security_list 始终返回空(部分公共节点不服务该接口), 则 ok=false 并返回
         categoriesSeen 便于排查; 上游(server)会优雅降级回本地快照, 不影响系统。

    返回 { ok, count, stocks:[{code,name,market}], host, categoriesSeen? }
      - code: 标准代码(前缀+6位), 如 sh600519 / sz000001 / bj8xxxxx
      - name: 证券名称
      - market: sh/sz/bj
      - limit>0 时仅返回前 N 只(供「测试接口」探活, 避免拉全量)
    """
    if not _auth_ok(request):
        return JSONResponse({"ok": False, "reason": "unauthorized"}, status_code=401)
    if TdxHq_API is None:
        return JSONResponse({"ok": False, "reason": "pytdx 未安装: %s" % _IMPORT_ERR}, status_code=500)

    # 市场: 0=深圳, 1=上海, 2=北交(部分版本北交归在 0/1, 这里一并尝试)
    MARKETS = [0, 1, 2]
    out = []
    categories_seen = set()
    any_count = 0
    cap = int(limit) if (limit and limit > 0) else 0
    try:
        for m in MARKETS:
            try:
                total = POOL.security_count(m)
            except Exception:
                total = 0
            any_count = max(any_count, total)
            if not total:
                continue
            start = 0
            while start < total:
                lst = POOL.security_list(m, start, 1000)
                if not lst:
                    break
                for it in lst:
                    cat = it.get("category")
                    categories_seen.add(cat)
                    if cat != 1:        # category 1 = 股票 (A股); 基金/债券/指数等排除
                        continue
                    code = str(it.get("code") or "")
                    if len(code) != 6 or not code.isdigit():
                        continue
                    name = it.get("name") or code
                    prefix = prefix_of(code)
                    out.append({"code": prefix + code, "name": name, "market": prefix})
                if cap and len(out) >= cap:
                    out = out[:cap]
                    break
                start += 1000
            if cap and len(out) >= cap:
                break
    except Exception as e:
        if not out:
            return JSONResponse({"ok": False, "reason": "枚举失败: %s" % e}, status_code=502)

    # 跨市场去重(同一代码可能重复出现)
    seen = set()
    deduped = []
    for s in out:
        if s["code"] in seen:
            continue
        seen.add(s["code"])
        deduped.append(s)

    # 空结果但服务器确有证券 -> 节点未服务列表接口, 明确降级
    if not deduped and any_count > 0:
        return JSONResponse({
            "ok": False,
            "reason": "该节点 get_security_list 返回空(已有 %d 只证券计数但未返回列表), 可能为公共节点限制。"
                      "请尝试在「🧩 TDX 网关」页配置 TDX_HOSTS 为可服务列表接口的节点, 或在东财可用时切换；"
                      "上游将回退本地快照。" % any_count,
            "categoriesSeen": sorted([c for c in categories_seen if c is not None]),
            "host": POOL.connected_host,
        }, status_code=200)

    return {
        "ok": True,
        "count": len(deduped),
        "stocks": deduped,
        "host": POOL.connected_host,
        "categoriesSeen": (sorted([c for c in categories_seen if c is not None]) if not deduped else None),
    }


@app.get("/kline")
def kline(request: Request,
          code: str = "",
          setcode: str = "0",
          period: str = "7",
          category: str = "",
          startxh: int = 0,
          wantNum: int = 800,
          tqFlag: str = "1"):
    if not _auth_ok(request):
        return JSONResponse({"ok": False, "reason": "unauthorized"}, status_code=401)
    if TdxHq_API is None:
        return JSONResponse({"ok": False, "reason": "pytdx 未安装: %s" % _IMPORT_ERR}, status_code=500)
    code = str(code).strip()
    if not code:
        return JSONResponse({"ok": False, "reason": "缺少 code"}, status_code=400)

    market = market_of(setcode)
    # category 直传优先; 未传则按 period 默认 1 分钟线(向后兼容分时契约)
    if category is not None and str(category).strip() != "":
        try:
            cat = int(category)
        except Exception:
            return JSONResponse({"ok": False, "reason": "category 非法: %s" % category}, status_code=400)
    else:
        cat = CATEGORY_1MIN
    count = max(1, min(int(wantNum), 800))  # pytdx 单次上限 800
    start = max(0, int(startxh))

    cache_key = (market, code, cat, start, count)
    cached = cache_get(cache_key)
    if cached is not None:
        return {"ok": True, "rows": cached, "cached": True}

    try:
        bars = POOL.get_bars(cat, market, code, start, count)
    except Exception as e:
        return JSONResponse({"ok": False, "reason": str(e)}, status_code=502)

    rows = [bar_to_row(b) for b in bars]
    rows = [r for r in rows if r["time"] and r["price"] is not None]
    cache_put(cache_key, rows)
    return {"ok": True, "rows": rows, "category": cat, "host": POOL.connected_host}


if __name__ == "__main__":
    print("[tdx_gateway] listening on %s:%d  token=%s  hosts=%d  gap=%dms" % (
        BIND, PORT, "SET" if TOKEN else "OFF", len(DEFAULT_HOSTS), REQUEST_GAP_MS))
    if TdxHq_API is None:
        print("[tdx_gateway] 警告: pytdx 未安装, /kline 将报错。请先 pip install -r requirements.txt")
    uvicorn.run(app, host=BIND, port=PORT, log_level="info")
