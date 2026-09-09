import React, { useState, useEffect, useRef } from 'react';
import { api, fmt, normCode } from '../api';
import Chart, { equityOption } from '../components/Chart';
import IntradayTradeChart from '../components/IntradayTradeChart';
import DcaReplayChart from '../components/DcaReplayChart';
import {
  readFileAsText, parseCsv, detectColumns, buildBars, inspect,
  FIELDS, shiftYears,
} from '../lib/csvImport';

const STRATS = [
  { k: 't0', t: '做T (5分)' },
  { k: 'ma', t: 'MA金叉 (日K)' },
  { k: 'st', t: '短线S系 (日K)' },
  { k: 'dca', t: '📊 定投回测' },
  { k: 'custom', t: '✍️ 自定义策略' },
  { k: 'manual', t: '🖱 手动买卖点' },
];

// 定投加码阶梯默认值(与后端 dca.js DEFAULT_TIERS 一致; 用 999 代替 Infinity 便于 JSON 序列化)
const DCA_DEFAULT_TIERS = '[\n  {"dev":-30,"mul":2.0},\n  {"dev":-15,"mul":1.5},\n  {"dev":15,"mul":1.0},\n  {"dev":30,"mul":0.7},\n  {"dev":999,"mul":0.5}\n]';

const ST_RULES = [
  { k: 'S00', t: 'S00 放量突破新高' },
  { k: 'S01', t: 'S01 量能验证突破' },
  { k: 'S02', t: 'S02 低位均线回踩' },
  { k: 'S03', t: 'S03 封板次日跟踪' },
  { k: 'S04', t: 'S04 强势回调整理' },
  { k: 'S06', t: 'S06 缩量蓄势' },
];

const CUSTOM_TEMPLATE = `// 自定义做T策略
// days: [{ date:'YYYY-MM-DD', bars:[{ t, datetime, open, high, low, close, volume, amount }] }]
// ctx:  { qty:Number }
// 返回: [{ date, buy_p, sell_p }]  (买=卖=qty 股, 不留隔夜)
function strategy(days, ctx) {
  const trades = [];
  for (const { date, bars } of days) {
    if (bars.length < 12) continue;
    const first = bars[0].close;
    const morning = bars.filter((b) => b.t >= '09:40' && b.t <= '11:30');
    const afternoon = bars.filter((b) => b.t >= '13:00');
    if (!morning.length || !afternoon.length) continue;
    const maxMorning = Math.max.apply(null, morning.map((b) => b.close));
    if (maxMorning / first - 1 < 0.005) continue; // 上午无足够动量则跳过
    const buy = morning[morning.length - 1].close;             // 上午收盘买入
    const sell = Math.max.apply(null, afternoon.map((b) => b.close)); // 下午最高卖出
    trades.push({ date, buy_p: buy, sell_p: sell });
  }
  return trades;
}
`;

// 由一笔交易推导某交易日分时图上的买卖点(仅给 price, 由图表自动落点)
function marksForTrade(trade, date, strategy) {
  if (strategy === 'st') {
    if (date === trade.buy_date) return [{ price: trade.buy_p, type: 'buy' }];
    if (date === trade.sell_date) return [{ price: trade.sell_p, type: 'sell' }];
    return [];
  }
  return [{ price: trade.buy_p, type: 'buy' }, { price: trade.sell_p, type: 'sell' }];
}

// 结果分时查看器: 点击交易明细行 -> 在分时图叠加该笔买卖点
function TradeIntraday({ code, trade, strategy }) {
  const dates = strategy === 'st' ? [trade.buy_date, trade.sell_date] : [trade.date];
  const [selDate, setSelDate] = useState(dates[0]);
  useEffect(() => { setSelDate(dates[0]); }, [trade, strategy]);
  const marks = marksForTrade(trade, selDate, strategy);
  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 6, alignItems: 'center' }}>
        {strategy === 'st' ? (
          <>
            <button className={'btn ' + (selDate === trade.buy_date ? 'primary' : '')} onClick={() => setSelDate(trade.buy_date)}>买入日 {trade.buy_date}</button>
            <button className={'btn ' + (selDate === trade.sell_date ? 'primary' : '')} onClick={() => setSelDate(trade.sell_date)}>卖出日 {trade.sell_date}</button>
          </>
        ) : (
          <span className="muted">交易日 {selDate}</span>
        )}
        <span className="muted" style={{ marginLeft: 'auto' }}>🔴买点 / 🟢卖点 (虚线为成交价参考)</span>
      </div>
      <IntradayTradeChart code={code} date={selDate} marks={marks} height={300} title={'交易买卖点 · ' + selDate} />
    </div>
  );
}

// 从回测结果提炼摘要(用于策略库快照展示)
function summaryOf(res) {
  if (!res || !res.ok || !res.metrics) return null;
  return { trades: res.trades.length, net: res.metrics.net, win_rate: res.metrics.win_rate, days: res.metrics.days };
}

// 自定义策略编辑器(含使用说明文档 + 保存到策略库)
function CustomEditor({ customName, setCustomName, customCode, setCustomCode, onRun, loading, res, onSave, saving }) {
  return (
    <div className="panel">
      <h3>✍️ 自定义策略编写</h3>
      <div className="doc" style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 12.5, lineHeight: 1.7 }}>
        <b>📖 使用说明</b>
        <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
          <li>编写一个函数 <code>function strategy(days, ctx)</code>，对每只交易日返回若干笔 <code>&#123; date, buy_p, sell_p &#125;</code>（买=卖=qty 股，不留隔夜）。</li>
          <li>输入 <code>days</code>：交易日数组，每项 <code>&#123; date, bars:[&#123; t, datetime, open, high, low, close, volume, amount &#125;] &#125;</code>。</li>
          <li>输入 <code>ctx</code>：<code>&#123; qty &#125;</code>（当前股数）。</li>
          <li>返回 <code>[&#123; date, buy_p, sell_p &#125;]</code> 即视为一笔做T交易；系统自动按 qty 计算收益与手续费。</li>
          <li>沙箱执行、单次限时 <b>2 秒</b>；仅暴露 Math/Date/JSON 等安全全局，<b>无法访问文件或网络</b>，可放心编写。</li>
          <li>点击「载入示例」可获得一份可直接运行的动量做T模板。</li>
        </ul>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="策略名称" value={customName} onChange={(e) => setCustomName(e.target.value)} style={{ width: 160 }} />
        <button className="btn" onClick={() => setCustomCode(CUSTOM_TEMPLATE)}>载入示例</button>
        <button className="btn primary" onClick={onRun} disabled={loading}>{loading ? '运行中…' : '运行自定义策略'}</button>
        <button className="btn" onClick={() => onSave(customName)} disabled={saving || !res || !res.ok}>{saving ? '保存中…' : '💾 保存到策略库'}</button>
        {res && res.ok && <span className="muted">已得 {res.trades.length} 笔，净 {fmt.money(res.metrics.net)}</span>}
      </div>
      <textarea
        value={customCode}
        onChange={(e) => setCustomCode(e.target.value)}
        spellCheck={false}
        style={{ width: '100%', height: 240, fontFamily: 'Consolas,Menlo,monospace', fontSize: 13, lineHeight: 1.5, padding: 8, boxSizing: 'border-box', border: '1px solid #ddd', borderRadius: 4 }}
      />
    </div>
  );
}

// 手动买卖点编辑器: 分时图点击标注 -> 回测 -> 保存策略库
function ManualEditor({ code, marks, setMarks, onRun, loading, res, onSave, saving }) {
  const [dates, setDates] = useState([]);
  const [selDate, setSelDate] = useState('');
  const [mode, setMode] = useState('buy');
  const [saveName, setSaveName] = useState('');
  const [lastMark, setLastMark] = useState(null); // 最近一次成功设置的买卖点(即时反馈)

  useEffect(() => {
    if (!code) return;
    // 手动买卖点必须基于分钟级(intraday)数据: 仅取已落盘1分钟分时日期
    // 注意: api.backtestDates(code,true) 已直接返回日期数组(非响应对象), 故此处 d 即数组
    api.backtestDates(code, true).then((d) => {
      setDates(d || []);
      setSelDate((prev) => (d && d.includes(prev) ? prev : (d && d[0] ? d[0] : '')));
    });
  }, [code]);

  const addMark = (m) => { setMarks((prev) => [...prev, { ...m, id: Date.now() + Math.random() }]); setLastMark(m); };
  const delMark = (id) => setMarks((prev) => prev.filter((m) => m.id !== id));
  const dayMarks = marks.filter((m) => m.date === selDate);

  return (
    <div className="panel">
      <h3>🖱 分时图手动买卖点</h3>
      <div className="muted" style={{ marginBottom: 6 }}>
        ① 选任意交易日（仅分钟级分时日期）→ ② 在分时图点击标注<b>买点</b>与<b>卖点</b>（作为"锚点"）→
        ③ 系统用 <code>锚点价 / 当时均价</code> 推导一个通用公式：<code>买入比 rBuy</code>、<code>卖出比 rSell</code> →
        ④「用公式回测全部分时日期」对股票<b>所有</b>分时日逐日回测（T+0，不限你点选的那天）→ ⑤「保存到策略库」复用公式。
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={selDate} onChange={(e) => setSelDate(e.target.value)}>
          {dates.length ? dates.map((d) => <option key={d} value={d}>{d}</option>) : <option value="">（无可用日期）</option>}
        </select>
        <button className={'btn ' + (mode === 'buy' ? 'primary' : '')} onClick={() => setMode('buy')}>＋买点</button>
        <button className={'btn ' + (mode === 'sell' ? 'primary' : '')} onClick={() => setMode('sell')}>＋卖点</button>
        <button className="btn" onClick={() => setMarks([])}>清空</button>
        <button className="btn primary" onClick={onRun} disabled={loading || !marks.length}>{loading ? '回测中…' : '用公式回测全部分时日期'}</button>
        <input placeholder="策略名(保存用)" value={saveName} onChange={(e) => setSaveName(e.target.value)} style={{ width: 150 }} />
        <button className="btn" onClick={() => onSave(saveName)} disabled={saving || !marks.length}>{saving ? '保存中…' : '💾 保存到策略库'}</button>
        <span className="muted">共 {marks.length} 点</span>
      </div>

      {selDate && (
        <div style={{ marginTop: 8 }}>
          <IntradayTradeChart code={code} date={selDate} marks={dayMarks} interactive markMode={mode} onAddMark={addMark} height={320} title={'手动标注 · ' + selDate} />
          {lastMark && lastMark.date === selDate && (
            <div style={{ marginTop: 6, padding: '6px 10px', fontSize: 13, borderRadius: 6, border: '1px solid ' + (lastMark.type === 'buy' ? '#e23c3c' : '#1aa260'), background: lastMark.type === 'buy' ? 'rgba(226,60,60,.08)' : 'rgba(26,162,96,.08)' }}>
              ✅ 已设置{lastMark.type === 'buy' ? '买' : '卖'}点：时间 <b>{lastMark.time}</b>　价格 <b>¥{lastMark.price}</b>（继续点击可添加更多，下方列表与分时图同步更新）
            </div>
          )}
        </div>
      )}

      {marks.length > 0 && (
        <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 8 }}>
          <table>
            <thead><tr><th>日期</th><th>时间</th><th>价格</th><th>类型</th><th>操作</th></tr></thead>
            <tbody>
              {marks.map((m) => (
                <tr key={m.id}>
                  <td>{m.date}</td><td>{m.time}</td><td>{m.price}</td>
                  <td className={m.type === 'buy' ? 'up' : 'down'}>{m.type === 'buy' ? '买' : '卖'}</td>
                  <td><button className="btn" style={{ padding: '2px 6px' }} onClick={() => delMark(m.id)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// 📚 我的策略库
function StrategyLibrary({ lib, onRun, onDelete }) {
  if (!lib.length) return (
    <div className="panel">
      <h3>📚 我的策略库</h3>
      <div className="muted">尚无保存的策略。运行「✍️ 自定义策略」或「🖱 手动买卖点」后，点「💾 保存到策略库」即可在此复用 / 回测。</div>
    </div>
  );
  return (
    <div className="panel">
      <h3>📚 我的策略库 <span className="muted">（{lib.length} 个）</span></h3>
      <table>
        <thead><tr><th>名称</th><th>类型</th><th>股票</th><th>净收益</th><th>胜率</th><th>笔数</th><th>操作</th></tr></thead>
        <tbody>
          {lib.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.type === 'manual' ? '🖱 手动点' : '✍️ 代码'}</td>
              <td>{s.stock_code}</td>
              <td className={s.summary ? fmt.cls(s.summary.net) : ''}>{s.summary ? fmt.money(s.summary.net) : '—'}</td>
              <td>{s.summary ? s.summary.win_rate + '%' : '—'}</td>
              <td>{s.summary ? s.summary.trades : '—'}</td>
              <td>
                <button className="btn primary" style={{ padding: '2px 8px' }} onClick={() => onRun(s)}>运行</button>{' '}
                <button className="btn" style={{ padding: '2px 8px' }} onClick={() => onDelete(s.id)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- 定投策略回测 (DCA) ----------

// 数据源: 手动导入 CSV / 使用本地库; 参数表单 + 导入 + 运行
function DcaPanel({ code, loading, onRun }) {
  const [srcMode, setSrcMode] = useState('import'); // import | db
  const [file, setFile] = useState(null);          // { name, status, head, rows, mapping, bars, preview }
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [params, setParams] = useState({
    freq: 'monthly', everyNDays: 20, dayOfWeek: 1, dayOfMonth: 1,
    amount: 5000, priceMode: 'close', lotMode: 'lot100', carryOver: true,
    boostMode: 'off', maPeriod: 250, boostTiers: DCA_DEFAULT_TIERS, dropPct: 5, dropMul: 2,
    takeMode: 'off', takeValue: 30, afterTake: 'restart',
    buyRule: 'fixed',
    dividendReinvest: true,
    start: '', end: '',
    commRate: 0.00025, commMin: 5, stampRate: 0.0005, transferRate: 0.00001, benchRate: 3,
    buyMode: 'amount', sharesPerPeriod: 100, priceType: 'raw',
  });
  const setP = (k, v) => setParams((p) => ({ ...p, [k]: v }));

  const handleFile = async (f) => {
    if (!f) return;
    setImportMsg('');
    setFile({ name: f.name, status: 'parsing' });
    try {
      const { text } = await readFileAsText(f);
      const { head, rows } = parseCsv(text);
      const mapping = detectColumns(head);
      const bars = buildBars(rows, mapping);
      const preview = inspect(bars, params.priceType);
      setFile({ name: f.name, status: preview.ok ? 'done' : 'warn', head, rows: rows.length, mapping, bars, preview });
    } catch (e) {
      setFile({ name: f.name, status: 'error', error: e.message });
    }
  };

  const onImportDb = async () => {
    if (!file || !file.bars || !file.bars.length) { alert('请先解析 CSV 再写入本地库'); return; }
    setImporting(true); setImportMsg('');
    try {
      const r = await api.importDayline({ code: normCode(code), bars: file.bars });
      setImportMsg(r.ok ? ('✅ 已写入 ' + r.written + ' 根（' + r.from + ' ~ ' + r.to + '）' + (r.skipped ? '，跳过 ' + r.skipped + ' 行' : '')) : ('❌ ' + r.error));
    } catch (e) { setImportMsg('❌ ' + e.message); }
    finally { setImporting(false); }
  };

  const run = async () => {
    if (srcMode === 'import') {
      if (!file || !file.bars || !file.bars.length) { alert('请先导入并解析日线 CSV 文件'); return; }
      if (file.preview && !file.preview.ok) { alert('数据体检未通过：' + (file.preview.error || '')); return; }
    }
    let tiers = null;
    if (params.boostMode !== 'off') {
      try { tiers = JSON.parse(params.boostTiers); } catch (e) { alert('加码阶梯 JSON 解析失败：' + e.message); return; }
    }
    const body = {
      code: normCode(code), strategy: 'dca',
      params: {
        freq: params.freq, everyNDays: Number(params.everyNDays),
        dayOfWeek: Number(params.dayOfWeek), dayOfMonth: Number(params.dayOfMonth),
        amount: Number(params.amount), priceMode: params.priceMode, lotMode: params.lotMode,
        carryOver: params.carryOver,
        buyRule: params.buyRule,
        dividendReinvest: params.priceType !== 'qfq' ? !!params.dividendReinvest : false,
        buyMode: params.buyMode, sharesPerPeriod: Number(params.sharesPerPeriod),
        priceType: params.priceType,
        boostMode: params.boostMode, maPeriod: Number(params.maPeriod),
        boostTiers: tiers, dropPct: Number(params.dropPct), dropMul: Number(params.dropMul),
        takeMode: params.takeMode, takeValue: Number(params.takeValue), afterTake: params.afterTake,
        start: params.start, end: params.end,
        commRate: Number(params.commRate), commMin: Number(params.commMin),
        stampRate: Number(params.stampRate), transferRate: Number(params.transferRate), benchRate: Number(params.benchRate),
      },
    };
    if (srcMode === 'import') body.bars = file.bars;
    // 红利再投: 仅除权(原始)数据, 运行前拉取分红事件并随回测体下发
    if (body.params.dividendReinvest) {
      try {
        const dr = await api.getDividend(normCode(code));
        if (dr && dr.ok && dr.dividends && dr.dividends.length) body.dividends = dr.dividends;
      } catch (_) { /* 拉取失败不影响主回测, 引擎会回退本地库 */ }
    }
    onRun(body);
  };

  const lbl = (t, c) => <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{t}{c}</label>;

  return (
    <div className="panel">
      <h3>📊 定投策略回测 (DCA)</h3>

      <div className="doc" style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 12.5, lineHeight: 1.7 }}>
        <b>📖 使用说明</b>
        <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
          <li>① <b>手动导入</b>日线 CSV（含 日期/开盘/收盘 即可，最高最低/成交量可选）——系统自动识别列、按所选价格类型（除权/前复权）清洗与体检。请如实选择<b>价格类型</b>：除权=真实价格含除权跳空；前复权=已复权连续。</li>
          <li>② 设定<b>定投周期</b>（每月/每周/每N日…）、每期金额、加码与止盈规则。</li>
          <li>③ 运行后将以<b>时间轴动画</b>回放：K线逐步推进、买点打点、持仓成本与市值曲线实时生长，可播放/暂停/调速/拖动进度。</li>
          <li>“写入本地库”可将表格持久化到 SQLite，之后切换“使用本地库”即可免重复上传直接回测。</li>
        </ul>
      </div>

      {/* 数据源切换 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted">数据来源：</span>
        <button className={'btn ' + (srcMode === 'import' ? 'primary' : '')} onClick={() => setSrcMode('import')}>📥 手动导入 CSV</button>
        <button className={'btn ' + (srcMode === 'db' ? 'primary' : '')} onClick={() => setSrcMode('db')}>🗄 使用本地库</button>
      </div>

      {srcMode === 'import' && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted">价格类型：</span>
          <select value={params.priceType} onChange={(e) => setP('priceType', e.target.value)}>
            <option value="raw">除权(原始)</option>
            <option value="qfq">前复权</option>
          </select>
          <span className="muted" style={{ fontSize: 12 }}>除权=真实价格含除权跳空；前复权=已复权连续（影响负价截断与收益率口径）</span>
        </div>
      )}

      {srcMode === 'import' && (
        <div style={{ marginBottom: 8 }}>
          <label className="btn" style={{ display: 'inline-block', cursor: 'pointer' }}>
            📂 选择 CSV 文件
            <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => handleFile(e.target.files[0])} style={{ display: 'none' }} />
          </label>
          {file && file.status === 'parsing' && <span className="muted" style={{ marginLeft: 8 }}>解析中…</span>}
          {file && (file.status === 'done' || file.status === 'warn') && (
            <div style={{ marginTop: 8, border: '1px solid #eee', borderRadius: 6, padding: 8, fontSize: 13 }}>
              <div><b>{file.name}</b>　解析到 <b>{file.rows}</b> 行，有效 <b>{file.preview.valid}</b> 行（{file.preview.from} ~ {file.preview.to}），跳过 <b>{file.preview.skipped}</b> 行。</div>
              <div style={{ marginTop: 6 }}>
                {FIELDS.map((f) => {
                  const idx = file.mapping[f.k];
                  const ok = idx >= 0;
                  const missReq = f.req && !ok;
                  return <span key={f.k} title={ok ? '识别为「' + file.head[idx] + '」' : '未识别'} style={{ display: 'inline-block', margin: '2px 4px 2px 0', padding: '2px 7px', borderRadius: 10, fontSize: 12, border: '1px solid ' + (missReq ? '#e23c3c' : ok ? '#1aa260' : '#ddd'), color: missReq ? '#e23c3c' : ok ? '#1aa260' : '#999', background: ok || missReq ? 'transparent' : '#f6f6f6' }}>{f.t}{ok ? '✓' : (missReq ? '✗必填' : '·')}</span>;
                })}
              </div>
              {file.preview.issues && file.preview.issues.map((it, i) => (
                <div key={i} style={{ marginTop: 4, color: it.lv === 'warn' ? '#b26a00' : it.lv === 'info' ? '#3a6ea5' : '#e23c3c' }}>• {it.msg}</div>
              ))}
              <div style={{ marginTop: 8 }}>
                <button className="btn" onClick={onImportDb} disabled={importing}>{importing ? '写入中…' : '💾 写入本地库'}</button>
                {importMsg && <span className="muted" style={{ marginLeft: 8 }}>{importMsg}</span>}
              </div>
            </div>
          )}
          {file && file.status === 'error' && <div style={{ marginTop: 6, color: '#e23c3c' }}>❌ 解析失败：{file.error}</div>}
        </div>
      )}

      {srcMode === 'db' && (
        <div className="muted" style={{ marginBottom: 8 }}>
          ℹ️ 使用本地 SQLite 中 <b>{normCode(code)}</b> 的日线数据回测。若为空，请先切到“手动导入 CSV”并点“💾 写入本地库”。
        </div>
      )}

      {/* 参数表单 */}
      <div style={{ borderTop: '1px dashed #eee', paddingTop: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span className="muted">定投周期</span>
          <select value={params.freq} onChange={(e) => setP('freq', e.target.value)}>
            <option value="monthly">每月</option><option value="biweekly">每两周</option>
            <option value="weekly">每周</option><option value="daily">每日</option><option value="custom">每 N 日</option>
          </select>
          {params.freq === 'custom' && lbl('每', <input type="number" value={params.everyNDays} onChange={(e) => setP('everyNDays', +e.target.value)} style={{ width: 56 }} />)}
          {(params.freq === 'weekly' || params.freq === 'biweekly') && <label className="muted">星期
            <select value={params.dayOfWeek} onChange={(e) => setP('dayOfWeek', +e.target.value)} style={{ marginLeft: 4 }}>
              <option value={1}>一</option><option value={2}>二</option><option value={3}>三</option><option value={4}>四</option><option value={5}>五</option>
            </select></label>}
          {params.freq === 'monthly' && lbl('每月第', <input type="number" value={params.dayOfMonth} onChange={(e) => setP('dayOfMonth', +e.target.value)} style={{ width: 48 }} />)}
          {params.buyMode === 'shares'
            ? lbl('每期股数', <input type="number" min="0" step="100" value={params.sharesPerPeriod} onChange={(e) => setP('sharesPerPeriod', +e.target.value)} style={{ width: 90 }} />)
            : lbl('每期金额 ¥', <input type="number" value={params.amount} onChange={(e) => setP('amount', +e.target.value)} style={{ width: 90 }} />)}
          <label className="muted">买入方式
            <select value={params.buyMode} onChange={(e) => setP('buyMode', e.target.value)} style={{ marginLeft: 4 }}>
              <option value="amount">按金额</option><option value="shares">按股数(整百)</option>
            </select></label>
          <label className="muted">成交价
            <select value={params.priceMode} onChange={(e) => setP('priceMode', e.target.value)} style={{ marginLeft: 4 }}>
              <option value="close">收盘</option><option value="open">开盘</option><option value="avgHL">均价</option>
            </select></label>
          <label className="muted">股数
            <select value={params.lotMode} onChange={(e) => setP('lotMode', e.target.value)} style={{ marginLeft: 4 }}>
              <option value="lot100">整百手</option><option value="exact">精确股</option>
            </select></label>
          {params.buyMode !== 'shares' && <label className="muted"><input type="checkbox" checked={params.carryOver} onChange={(e) => setP('carryOver', e.target.checked)} style={{ marginRight: 4 }} />余额结转</label>}
          <label className="muted">买入规则
            <select value={params.buyRule} onChange={(e) => setP('buyRule', e.target.value)} style={{ marginLeft: 4 }}>
              <option value="fixed">按计划买入</option><option value="downtick">下跌才买入</option>
            </select></label>
          {params.priceType === 'qfq'
            ? <span className="muted" style={{ fontSize: 12, color: '#999' }} title="前复权价格已含分红，红利再投会重复计，故不适用">红利再投：前复权不适用</span>
            : <label className="muted" title="除权数据时，现金分红按除权日收盘自动买入、送股/转增按比例增加股数，让收益含红利再投"><input type="checkbox" checked={params.dividendReinvest} onChange={(e) => setP('dividendReinvest', e.target.checked)} style={{ marginRight: 4 }} />红利再投</label>}
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span className="muted">智能加码</span>
          {params.buyMode === 'shares' && <span className="muted" style={{ fontSize: 12, color: '#b26a00' }}>（按股数模式固定股数，不启用加码/结转）</span>}
          <select value={params.boostMode} onChange={(e) => setP('boostMode', e.target.value)}>
            <option value="off">关闭</option><option value="ma">均线偏离</option><option value="drop">逢跌加倍</option>
          </select>
          {params.boostMode === 'ma' && lbl('MA', <input type="number" value={params.maPeriod} onChange={(e) => setP('maPeriod', +e.target.value)} style={{ width: 56 }} />)}
          {params.boostMode === 'drop' && (<>
            {lbl('跌幅≥', <input type="number" value={params.dropPct} onChange={(e) => setP('dropPct', +e.target.value)} style={{ width: 48 }} />)}
            {lbl('% 加', <input type="number" value={params.dropMul} onChange={(e) => setP('dropMul', +e.target.value)} style={{ width: 48 }} />)}
            <span className="muted">倍</span>
          </>)}
          {params.boostMode !== 'off' && (
            <details style={{ width: '100%', marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', color: '#5a6270' }}>加码阶梯 JSON（偏离% → 倍数，默认 5 档）</summary>
              <textarea value={params.boostTiers} onChange={(e) => setP('boostTiers', e.target.value)} spellCheck={false}
                style={{ width: '100%', height: 110, fontFamily: 'Consolas,Menlo,monospace', fontSize: 12, marginTop: 4, border: '1px solid #ddd', borderRadius: 4, padding: 6 }} />
            </details>
          )}
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span className="muted">止盈</span>
          <select value={params.takeMode} onChange={(e) => setP('takeMode', e.target.value)}>
            <option value="off">关闭</option><option value="ret">收益率</option><option value="xirr">年化(XIRR)</option>
          </select>
          {params.takeMode !== 'off' && (<>
            {lbl('达到', <input type="number" value={params.takeValue} onChange={(e) => setP('takeValue', +e.target.value)} style={{ width: 56 }} />)}
            <span className="muted">% 后</span>
            <select value={params.afterTake} onChange={(e) => setP('afterTake', e.target.value)}>
              <option value="restart">清仓重启定投</option><option value="stop">清仓停止</option>
            </select>
          </>)}
        </div>

        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: '#5a6270' }}>区间与交易费用（高级）</summary>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <label className="muted">起始日<input type="date" value={params.start} onChange={(e) => setP('start', e.target.value)} style={{ marginLeft: 4 }} /></label>
            <label className="muted">结束日<input type="date" value={params.end} onChange={(e) => setP('end', e.target.value)} style={{ marginLeft: 4 }} /></label>
            <span className="muted">快捷：</span>
            <button className="btn" style={{ padding: '3px 8px' }} onClick={() => setP('start', shiftYears(file && file.preview ? file.preview.to : new Date().toISOString().slice(0, 10), 5))}>近5年</button>
            <button className="btn" style={{ padding: '3px 8px' }} onClick={() => setP('start', shiftYears(file && file.preview ? file.preview.to : new Date().toISOString().slice(0, 10), 10))}>近10年</button>
          </div>

          <div style={{ marginTop: 10, borderTop: '1px dashed #eee', paddingTop: 8 }}>
            <div className="muted" style={{ marginBottom: 6, fontWeight: 600 }}>💰 交易费用（影响净收益，按 A 股常见标准填写）</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 3 }}>佣金率 (%)</label>
                <input type="number" step="0.00001" value={params.commRate} onChange={(e) => setP('commRate', +e.target.value)} style={{ width: '100%', fontSize: 13, padding: '5px 6px', border: '1px solid #ddd', borderRadius: 4 }} />
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>券商交易佣金，买卖双向收取（如 0.025% = 万2.5）。</div>
              </div>
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 3 }}>最低佣金 (¥)</label>
                <input type="number" value={params.commMin} onChange={(e) => setP('commMin', +e.target.value)} style={{ width: '100%', fontSize: 13, padding: '5px 6px', border: '1px solid #ddd', borderRadius: 4 }} />
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>单笔佣金最低收取额，不足按此计（通常 ¥5）。</div>
              </div>
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 3 }}>印花税 (%)</label>
                <input type="number" step="0.0001" value={params.stampRate} onChange={(e) => setP('stampRate', +e.target.value)} style={{ width: '100%', fontSize: 13, padding: '5px 6px', border: '1px solid #ddd', borderRadius: 4 }} />
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>仅在卖出时收取（A股现行 0.05% = 万5）。</div>
              </div>
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 3 }}>过户费 (%)</label>
                <input type="number" step="0.00001" value={params.transferRate} onChange={(e) => setP('transferRate', +e.target.value)} style={{ width: '100%', fontSize: 13, padding: '5px 6px', border: '1px solid #ddd', borderRadius: 4 }} />
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>证券过户费，买卖双向（约 0.001% = 万0.1）。</div>
              </div>
              <div>
                <label className="muted" style={{ display: 'block', marginBottom: 3 }}>储蓄年化 (%)</label>
                <input type="number" value={params.benchRate} onChange={(e) => setP('benchRate', +e.target.value)} style={{ width: '100%', fontSize: 13, padding: '5px 6px', border: '1px solid #ddd', borderRadius: 4 }} />
                <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>机会成本基准——把定投结余现金与银行储蓄收益比较。</div>
              </div>
            </div>
          </div>
        </details>

        <div style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={run} disabled={loading || (srcMode === 'import' && (!file))}>{loading ? '回测中…' : '🚀 运行定投回测'}</button>
          <span className="muted" style={{ marginLeft: 8 }}>回测将以时间轴动画呈现结果</span>
        </div>
      </div>
    </div>
  );
}

// 定投回测结果: 指标卡 + 动画回放 + 对照表 + 交易明细
function DcaResult({ result }) {
  const m = result.metrics || {};
  const totalAsset = (Number(m.market_value) || 0) + (Number(m.realized) || 0);
  const cmp = result.compare || {};
  const cmpRows = [{ name: '定投（本策略）', invested: m.invested, mv: totalAsset, profit: m.profit, ret: m.return_pct, xirr: m.xirr }];
  if (cmp.lumpsum) cmpRows.push({ name: cmp.lumpsum.label, invested: cmp.lumpsum.invested, mv: cmp.lumpsum.market_value, profit: cmp.lumpsum.profit, ret: cmp.lumpsum.return_pct, xirr: cmp.lumpsum.xirr });
  if (cmp.deposit) cmpRows.push({ name: cmp.deposit.label, invested: cmp.deposit.invested, mv: cmp.deposit.market_value, profit: cmp.deposit.profit, ret: cmp.deposit.return_pct, xirr: cmp.deposit.xirr });

  const cards = [
    { k: '累计投入', v: fmt.money(m.invested) },
    { k: '持仓市值', v: fmt.money(m.market_value) },
    { k: '已实现收益', v: fmt.money(m.realized) },
    { k: '总资产', v: fmt.money(totalAsset) },
    { k: '总收益', v: fmt.money(m.profit), cls: fmt.cls(m.profit) },
    { k: '收益率', v: fmt.pct(m.return_pct), cls: fmt.cls(m.profit) },
    { k: '年化(XIRR)', v: m.xirr == null ? '--' : fmt.pct(m.xirr), cls: m.xirr == null ? '' : fmt.cls(m.xirr) },
    { k: '定投期数', v: m.periods },
    { k: '最大回撤', v: (m.mdd_pct || 0).toFixed(2) + '%', cls: 'down' },
    { k: '最大浮亏', v: (m.max_loss_pct || 0).toFixed(2) + '%', cls: 'down' },
    { k: '持仓成本', v: m.cost ? '¥' + Number(m.cost).toFixed(3) : '--' },
    { k: '持股数', v: Number(m.shares || 0).toLocaleString('zh-CN') },
    { k: '手续费', v: fmt.money(m.fee) },
  ];
  if (m.downtick_skips) cards.push({ k: '上涨跳过', v: m.downtick_skips + ' 天', cls: 'muted' });
  if (m.dividend_applied) {
    cards.push({ k: '红利再投次数', v: m.dividend_events + ' 次', cls: 'muted' });
    cards.push({ k: '红利再投金额', v: fmt.money(m.dividend_reinvested), cls: 'muted' });
    cards.push({ k: '红利再投股数', v: Number(m.dividend_shares || 0).toLocaleString('zh-CN'), cls: 'muted' });
  }

  return (
    <div>
      {result.meta && result.meta.warnings && result.meta.warnings.length > 0 && (
        <div className="panel" style={{ borderColor: '#ffb74d', background: 'rgba(255,183,77,.08)' }}>
          <b>⚠️ 数据提示</b>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{result.meta.warnings.map((w, i) => <li key={i} style={{ fontSize: 13 }}>{w}</li>)}</ul>
        </div>
      )}

      <div className="row" style={{ marginBottom: 4, flexWrap: 'wrap' }}>
        {cards.map((c) => <div className="metric" key={c.k}><div className="k">{c.k}</div><div className={'v ' + (c.cls || '')}>{c.v}</div></div>)}
      </div>

      <div className="panel">
        <h3>🎞 定投回放（时间轴动画） <span className="muted">{result.code} · {result.meta && result.meta.from} ~ {result.meta && result.meta.to}</span></h3>
        <DcaReplayChart result={result} height={400} />
      </div>

      <div className="panel">
        <h3>⚖️ 策略对照</h3>
        <table>
          <thead><tr><th>策略</th><th>累计投入</th><th>期末资产</th><th>总收益</th><th>收益率</th><th>年化</th></tr></thead>
          <tbody>
            {cmpRows.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td>
                <td>{fmt.money(r.invested)}</td>
                <td>{fmt.money(r.mv)}</td>
                <td className={fmt.cls(r.profit)}>{fmt.money(r.profit)}</td>
                <td className={r.ret == null ? '' : fmt.cls(r.ret)}>{r.ret == null ? '--' : fmt.pct(r.ret)}</td>
                <td className={r.xirr == null ? '' : fmt.cls(r.xirr)}>{r.xirr == null ? '--' : fmt.pct(r.xirr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 6 }}>对照：① 首日一次性买入等额资金（同成交价口径）；② 同期无风险储蓄（按设定年化复利）。用于直观评估“定投 vs 一把梭 vs 存银行”。</div>
      </div>

      <div className="panel">
        <h3>📋 交易明细 <span className="muted">共 {result.trades.length} 笔（买 {result.trades.filter((t) => t.type === 'buy').length} / 止盈卖 {result.trades.filter((t) => t.type === 'sell').length}）</span></h3>
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          <table>
            <thead><tr><th>序号</th><th>日期</th><th>方向</th><th>价格</th><th>股数</th><th>金额</th><th>费用</th><th>加码 / 收益</th></tr></thead>
            <tbody>
              {result.trades.slice().reverse().map((t, i) => (
                <tr key={i}>
                  <td>{t.seq}</td>
                  <td>{t.date}</td>
                  <td className={t.type === 'buy' ? 'up' : 'down'}>{t.type === 'buy' ? '买' : '止盈卖'}</td>
                  <td>{t.price}</td>
                  <td>{Number(t.shares || 0).toLocaleString('zh-CN')}</td>
                  <td>{fmt.money(t.amount)}</td>
                  <td className="muted">{fmt.money(t.fee)}</td>
                  <td>{t.type === 'buy' ? (t.mul !== 1 ? ('× ' + t.mul) : '—') : (fmt.pct(t.ret_pct) + ' / ' + fmt.money(t.profit))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function Backtest() {
  const [p, setP] = useState({
    code: 'sz002027', strategy: 't0', qty: 2000, variant: 'standard',
    windowDays: 182, rule: 'S01', holdDays: 5, stopPct: 5, takePct: 8,
  });
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [wl, setWl] = useState([]);
  const [customCode, setCustomCode] = useState(CUSTOM_TEMPLATE);
  const [customName, setCustomName] = useState('动量做T');
  const [manualMarks, setManualMarks] = useState([]);
  const [selTrade, setSelTrade] = useState(null);
  const [lib, setLib] = useState([]);
  const [saving, setSaving] = useState(false);

  const isManual = p.strategy === 'manual';

  useEffect(() => { api.watchlist().then((r) => setWl(r.data || [])); }, []);
  useEffect(() => { api.backtestStrategies().then((r) => setLib(r.data || [])); }, []);
  useEffect(() => {
    if (res && res.ok && res.trades && res.trades.length) setSelTrade(res.trades[0]);
    else setSelTrade(null);
  }, [res]);

  const pick = (c) => setP({ ...p, code: c });
  const loadLib = () => api.backtestStrategies().then((r) => setLib(r.data || []));

  const runWith = async (body) => {
    setLoading(true);
    const r = await api.backtest(body);
    setRes(r); setLoading(false);
  };

  const run = async () => {
    const code = normCode(p.code);
    const body = { code, strategy: p.strategy, qty: p.qty };
    if (p.strategy === 't0') { body.variant = p.variant; body.windowDays = p.windowDays; }
    if (p.strategy === 'st') { body.rule = p.rule; body.windowDays = p.windowDays; body.holdDays = p.holdDays; body.stopPct = p.stopPct; body.takePct = p.takePct; }
    if (p.strategy === 'ma') { /* 日K 策略无需额外参数 */ }
    if (p.strategy === 'custom') { body.customCode = customCode; body.customName = customName; body.windowDays = p.windowDays; }
    if (p.strategy === 'manual') { body.marks = manualMarks.map(({ id, ...rest }) => rest); }
    runWith(body);
  };

  // 保存到策略库
  const saveStrategy = async (payload) => {
    setSaving(true);
    try {
      const r = await api.saveBacktestStrategy(payload);
      if (r.ok) { await loadLib(); alert('已保存到策略库：' + payload.name); }
      else alert('保存失败：' + (r.error || ''));
    } finally { setSaving(false); }
  };
  const onSaveCustom = (name) => {
    const nm = (name && name.trim()) || customName || '自定义策略';
    saveStrategy({ name: nm, type: 'code', stock_code: normCode(p.code), js_code: customCode, qty: p.qty, windowDays: p.windowDays, summary: summaryOf(res) });
  };
  const onSaveManual = (name) => {
    const nm = (name && name.trim()) || ('手动买卖点-' + normCode(p.code));
    saveStrategy({ name: nm, type: 'manual', stock_code: normCode(p.code), marks: manualMarks.map(({ id, ...rest }) => rest), qty: p.qty, summary: summaryOf(res) });
  };

  // 从策略库运行
  const runSaved = (s) => {
    const code = s.stock_code || normCode(p.code);
    setP({ ...p, code, strategy: s.type });
    if (s.type === 'code') {
      setCustomCode(s.js_code); setCustomName(s.name);
      runWith({ code, strategy: 'custom', customCode: s.js_code, customName: s.name, qty: s.qty || p.qty, windowDays: s.windowDays || p.windowDays });
    } else {
      const marks = (s.marks || []).map((m) => ({ ...m, id: Date.now() + Math.random() }));
      setManualMarks(marks);
      runWith({ code, strategy: 'manual', marks: marks.map(({ id, ...rest }) => rest), qty: s.qty || p.qty });
    }
  };
  const deleteSaved = async (id) => {
    if (!confirm('确定删除该策略？')) return;
    await api.deleteBacktestStrategy(id);
    loadLib();
  };

  const m = res && res.ok ? res.metrics : null;
  const fetchInfo = res && res.ok && res.meta && res.meta.fetch;
  const isSt = res && res.ok && res.strategy === 'st';
  const isT0 = res && res.ok && res.strategy === 't0';

  return (
    <div>
      <div className="panel">
        <h3>🧪 策略回测</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={p.code} onChange={(e) => setP({ ...p, code: e.target.value.trim() })} style={{ width: 120 }} placeholder="代码如 000001" />
          {/* 策略类型: 可见按钮组(确保自定义/手动入口不被遗漏) */}
          <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {STRATS.map((s) => (
              <button key={s.k} className={'btn ' + (p.strategy === s.k ? 'primary' : '')} onClick={() => setP({ ...p, strategy: s.k })}>{s.t}</button>
            ))}
          </div>

          {p.strategy === 't0' && <select value={p.variant} onChange={(e) => setP({ ...p, variant: e.target.value })}>
            <option value="standard">标准T(推荐)</option><option value="naive">朴素持有(对照)</option><option value="ideal">极端理想(上限)</option>
          </select>}

          {p.strategy === 'st' && <select value={p.rule} onChange={(e) => setP({ ...p, rule: e.target.value })}>
            {ST_RULES.map((r) => <option key={r.k} value={r.k}>{r.t}</option>)}
          </select>}

          <label className="muted">股数<input type="number" value={p.qty} onChange={(e) => setP({ ...p, qty: +e.target.value })} style={{ width: 90, marginLeft: 4 }} /></label>

          {(p.strategy === 't0' || p.strategy === 'st' || p.strategy === 'custom') && <label className="muted">窗口天<input type="number" value={p.windowDays} onChange={(e) => setP({ ...p, windowDays: +e.target.value })} style={{ width: 70, marginLeft: 4 }} /></label>}

          {p.strategy === 'st' && <label className="muted">持有天<input type="number" value={p.holdDays} onChange={(e) => setP({ ...p, holdDays: +e.target.value })} style={{ width: 60, marginLeft: 4 }} /></label>}
          {p.strategy === 'st' && <label className="muted">止损%<input type="number" value={p.stopPct} onChange={(e) => setP({ ...p, stopPct: +e.target.value })} style={{ width: 50, marginLeft: 4 }} /></label>}
          {p.strategy === 'st' && <label className="muted">止盈%<input type="number" value={p.takePct} onChange={(e) => setP({ ...p, takePct: +e.target.value })} style={{ width: 50, marginLeft: 4 }} /></label>}

          {!isManual && p.strategy !== 'dca' && <button className="btn primary" onClick={run} disabled={loading}>{loading ? '回测中…' : '运行回测'}</button>}
          <span style={{ marginLeft: 'auto' }} className="muted">自选快切：</span>
          {wl.map((w) => <button key={w.code} className="btn" onClick={() => pick(w.code, w.name)} style={{ padding: '4px 8px' }}>{w.name}</button>)}
        </div>
        {fetchInfo && fetchInfo.fetched && (
          <div className="muted" style={{ marginTop: 8 }}>
            📥 自动抓取{p.strategy === 'st' ? '日K' : '5分钟'}数据：{fetchInfo.bars} 根（{fetchInfo.from} ~ {fetchInfo.to}，约 {fetchInfo.coveredDays} 个交易日）— {fetchInfo.note}
          </div>
        )}
        {fetchInfo && fetchInfo.error && (
          <div className="muted" style={{ marginTop: 8, color: '#e23c3c' }}>⚠️ 自动抓取失败：{fetchInfo.error}</div>
        )}
        {isSt && <div className="muted" style={{ marginTop: 6 }}>短线策略执行口径：信号日<b>次日开盘</b>买入 → 持有 <b>{res.params.holdDays}</b> 天 或 止损 <b>{(res.params.stopPct * 100).toFixed(0)}%</b> / 止盈 <b>{(res.params.takePct * 100).toFixed(0)}%</b> 卖出；共 <b>{res.meta.signals}</b> 个信号。</div>}
        {res && res.strategy === 'custom' && <div className="muted" style={{ marginTop: 6 }}>自定义策略「{res.customName}」执行口径：买=卖=qty，不留隔夜；共 <b>{res.trades.length}</b> 笔交易。</div>}
        {res && res.strategy === 'manual' && res.formula && (
          <div className="muted" style={{ marginTop: 6 }}>
            手动买卖点·公式回测：锚点推导 <b>买入比 r≤{res.formula.rBuy}</b> / <b>卖出比 r≥{res.formula.rSell}</b>（r = 价格÷当时均价）；
            对 <b>{res.meta && res.meta.evaluated}</b>/{res.meta && res.meta.totalDates} 个分时交易日逐日回测（{res.meta && res.meta.skipped} 日数据不足跳过），共 <b>{res.trades.length}</b> 笔配对交易，覆盖 <b>{res.meta && res.meta.tradeDays}</b> 个交易日。
          </div>
        )}
        {res && res.strategy === 'dca' && res.ok && (
          <div className="muted" style={{ marginTop: 6 }}>📊 定投回测：<b>{res.meta.from}</b> ~ <b>{res.meta.to}</b>（有效 <b>{res.meta.used}</b> 个交易日，<b>{res.metrics.periods}</b> 期买入，来源 {res.meta.source === 'import' ? '手动导入' : '本地库'}），跳过 <b>{res.meta.skipped}</b> 行。</div>
        )}
      </div>

      {res && !res.ok && <div className="panel" style={{ color: '#e23c3c' }}>回测失败：{res.error}</div>}

      {p.strategy === 'custom' && (
        <CustomEditor customName={customName} setCustomName={setCustomName} customCode={customCode} setCustomCode={setCustomCode}
          onRun={run} loading={loading} res={res} onSave={onSaveCustom} saving={saving} />
      )}
      {isManual && (
        <ManualEditor code={normCode(p.code)} marks={manualMarks} setMarks={setManualMarks} onRun={run} loading={loading}
          res={res} onSave={onSaveManual} saving={saving} />
      )}

      {p.strategy === 'dca' && (
        <DcaPanel code={p.code} loading={loading} onRun={runWith} />
      )}

      <StrategyLibrary lib={lib} onRun={runSaved} onDelete={deleteSaved} />

      {(m && res.strategy !== 'dca') && <>
        <div className="row" style={{ marginBottom: 4 }}>
          <div className="metric"><div className="k">净收益</div><div className={'v ' + fmt.cls(m.net)}>{fmt.money(m.net)}</div></div>
          <div className="metric"><div className="k">胜率</div><div className="v">{m.win_rate}%</div></div>
          <div className="metric"><div className="k">交易天/次</div><div className="v">{m.days}</div></div>
          <div className="metric"><div className="k">最大回撤</div><div className="v down">{fmt.money(m.mdd)}</div></div>
          <div className="metric"><div className="k">夏普</div><div className="v">{m.sharpe}</div></div>
          <div className="metric"><div className="k">手续费</div><div className="v" style={{ fontSize: 18 }}>{fmt.money(m.fee)}</div></div>
        </div>

        <div className="panel">
          <h3>📈 累计收益曲线 <span className="muted">{m.strategy}</span></h3>
          <Chart option={equityOption(m.equity)} height={260} />
        </div>

        {isSt && res.compare && <div className="panel">
          <h3>⚖️ 六档短线策略横向对比（同执行口径）</h3>
          <table>
            <thead><tr><th>规则</th><th>信号数</th><th>净收益</th><th>胜率</th><th>平均盈利</th><th>平均亏损</th><th>最大回撤</th><th>夏普</th></tr></thead>
            <tbody>{ST_RULES.map((r) => { const c = res.compare[r.k]; if (!c) return null;
              const hl = r.k === res.rule ? { background: 'rgba(255,170,0,0.12)' } : null;
              return <tr key={r.k} style={hl}><td style={{ maxWidth: 240, whiteSpace: 'normal' }}>{c.strategy}</td>
                <td>{c.signals}</td>
                <td className={fmt.cls(c.net)}>{fmt.money(c.net)}</td><td>{c.win_rate}%</td>
                <td className="up">{fmt.money(c.avg_win)}</td><td className="down">{fmt.money(c.avg_loss)}</td><td className="down">{fmt.money(c.mdd)}</td><td>{c.sharpe}</td></tr>; })}</tbody>
          </table>
          <div className="muted" style={{ marginTop: 6 }}>注：对比组内各策略独立执行（非互斥），用于横向评估哪类信号在历史样本上更优。</div>
        </div>}

        {isT0 && res.compare && <div className="panel">
          <h3>⚖️ 三档买卖点对比</h3>
          <table>
            <thead><tr><th>标准</th><th>净收益</th><th>胜率</th><th>平均盈利</th><th>平均亏损</th><th>最大回撤</th></tr></thead>
            <tbody>{['standard', 'naive', 'ideal'].map((k) => { const c = res.compare[k]; if (!c) return null;
              return <tr key={k}><td style={{ maxWidth: 320, whiteSpace: 'normal' }}>{c.strategy}</td>
                <td className={fmt.cls(c.net)}>{fmt.money(c.net)}</td><td>{c.win_rate}%</td>
                <td className="up">{fmt.money(c.avg_win)}</td><td className="down">{fmt.money(c.avg_loss)}</td><td className="down">{fmt.money(c.mdd)}</td></tr>; })}</tbody>
          </table>
          {res.median_gap_pct && <div className="muted" style={{ marginTop: 6 }}>日内价差中位数 <b>{res.median_gap_pct}%</b> → 决策面板买/卖区据此标定。</div>}
        </div>}

        <div className="panel">
          <h3>📋 交易明细 <span className="muted">共 {res.trades.length} 笔{res.strategy !== 'manual' && res.strategy !== 'st' ? '（点击任一行在分时图查看买卖点）' : ''}</span></h3>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            <table>
              {isSt ? (
                <thead><tr><th>买入日</th><th>卖出日</th><th>买价</th><th>卖价</th><th>持有天</th><th>退出</th><th>毛收益</th><th>费用</th><th>净收益</th></tr></thead>
              ) : res.strategy === 'manual' ? (
                <thead><tr><th>日期</th><th>买时间</th><th>卖时间</th><th>买价</th><th>卖价</th><th>毛收益</th><th>费用</th><th>净收益</th></tr></thead>
              ) : (
                <thead><tr><th>日期</th><th>买价</th><th>卖价</th><th>毛收益</th><th>费用</th><th>净收益</th></tr></thead>
              )}
              <tbody>{res.trades.slice().reverse().map((t, i) => {
                const clickable = res.strategy !== 'manual' && res.strategy !== 'st';
                return <tr key={i} onClick={clickable ? () => setSelTrade(t) : undefined} style={clickable ? { cursor: 'pointer' } : undefined}>
                  {isSt ? (
                    <>
                      <td>{t.buy_date}</td><td>{t.sell_date}</td><td>{t.buy_p}</td><td>{t.sell_p}</td>
                      <td>{t.hold_days}</td><td>{t.exit_reason}</td>
                      <td className={fmt.cls(t.gross)}>{fmt.money(t.gross)}</td><td className="muted">{fmt.money(t.fee)}</td>
                      <td className={fmt.cls(t.net)}>{fmt.money(t.net)}</td>
                    </>
                  ) : res.strategy === 'manual' ? (
                    <>
                      <td>{t.date}</td><td>{t.buy_time}</td><td>{t.sell_time}</td>
                      <td>{t.buy_p}</td><td>{t.sell_p}</td>
                      <td className={fmt.cls(t.gross)}>{fmt.money(t.gross)}</td><td className="muted">{fmt.money(t.fee)}</td>
                      <td className={fmt.cls(t.net)}>{fmt.money(t.net)}</td>
                    </>
                  ) : (
                    <>
                      <td>{t.date}</td><td>{t.buy_p}</td><td>{t.sell_p}</td>
                      <td className={fmt.cls(t.gross)}>{fmt.money(t.gross)}</td><td className="muted">{fmt.money(t.fee)}</td>
                      <td className={fmt.cls(t.net)}>{fmt.money(t.net)}</td>
                    </>
                  )}
                </tr>;
              })}</tbody>
            </table>
          </div>
        </div>

        {selTrade && res.strategy !== 'manual' && res.strategy !== 'dca' && (
          <div className="panel">
            <h3>📍 交易买卖点 · 分时图 <span className="muted">（点击明细行切换）</span></h3>
            <TradeIntraday code={normCode(p.code)} trade={selTrade} strategy={res.strategy} />
          </div>
        )}
      </>}

      {res && res.ok && res.strategy === 'dca' && <DcaResult result={res} />}
    </div>
  );
}
