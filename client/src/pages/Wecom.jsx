import React, { useEffect, useState, useRef, useMemo } from 'react';
import { api, fmt } from '../api';
import StockSnapshot from '../components/StockSnapshot';
import html2canvas from 'html2canvas';

const empty = {
  enabled: false,
  mode: 'webhook',
  webhook: { key: '' },
  app: { corpid: '', corpsecret: '', agentid: '', touser: '@all' },
  notifyBottom: true,
  notifyTop: true,
  notifyMinConfidence: 'high',
};

export default function Wecom() {
  const [cfg, setCfg] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null); // { type:'ok'|'err', text }
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // ===== 测试发送预览(用于抓取真实价格/均价/分时&K线截图) =====
  const [testCode, setTestCode] = useState('sz002027');
  const [testName, setTestName] = useState('分众传媒');
  const [tMinute, setTMinute] = useState([]);
  const [tQuote, setTQuote] = useState(null);
  const testSnapRef = useRef(null); // 三模块快照容器(测试截图用)

  const loadTest = (c) => {
    c = (c || '').trim();
    if (!c) return;
    api.quote([c]).then((r) => {
      const q = (r.data && r.data[0]) || null;
      if (q) { setTestName(q.name || testName); setTQuote(q); }
    });
    api.minute(c).then((r) => setTMinute(r.data || []));
  };

  useEffect(() => { loadTest(testCode); }, []);
  useEffect(() => {
    const t = setInterval(() => loadTest(testCode), 15000);
    return () => clearInterval(t);
  }, [testCode]);

  const lastBar = tMinute[tMinute.length - 1];
  const lastInfo = lastBar
    ? `实时价格：${fmt.price(lastBar.price)}　当日均价：${fmt.price(lastBar.avg)}　时间：${lastBar.t}`
    : '行情加载中…';

  useEffect(() => {
    api.wecomConfig().then((r) => {
      if (r.ok && r.data) setCfg((c) => ({ ...c, ...r.data, webhook: { ...empty.webhook, ...(r.data.webhook || {}) }, app: { ...empty.app, ...(r.data.app || {}) } }));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setWebhook = (patch) => setCfg((c) => ({ ...c, webhook: { ...c.webhook, ...patch } }));
  const setApp = (patch) => setCfg((c) => ({ ...c, app: { ...c.app, ...patch } }));

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveWecomConfig(cfg);
      if (r.ok) flash('ok', '配置已保存');
      else flash('err', '保存失败：' + (r.error || '未知错误'));
    } catch (e) { flash('err', '保存异常：' + e.message); }
    finally { setSaving(false); }
  };

  // 测试发送: 截「当日分时 + 做T决策面板 + 当前分时形态概率匹配」三模块为单张图随通知发送
  const test = async (type) => {
    setTesting(true);
    try {
      const lb = tMinute[tMinute.length - 1];
      // 取一个真实信号字段填充文字预览(优先同类型, 否则取最后一个); 无则给代表性样例
      let sig = null;
      try {
        const mr = await api.dotTopsBottoms(testCode);
        const marks = (mr && mr.ok && mr.marks) || [];
        sig = marks.find((m) => m.type === type) || marks[marks.length - 1] || null;
      } catch (_) { /* 忽略, 用样例值 */ }
      const images = [];
      try {
        if (testSnapRef.current) {
          const canvas = await html2canvas(testSnapRef.current, { backgroundColor: '#fff', pixelRatio: 1.5, scale: 1.5, logging: false });
          images.push(canvas.toDataURL('image/png'));
        }
      } catch (_) { /* 截图失败仍可发文字 */ }
      const r = await api.notify({
        type,
        code: testCode,
        name: (tQuote && tQuote.name) || testName,
        price: lb ? lb.price : undefined,
        avg: lb ? lb.avg : undefined,
        time: lb ? lb.t : undefined,
        confidence: sig ? sig.confidence : 'high',
        dev: sig ? sig.dev : (type === 'bottom' ? -2.1 : 2.3),
        divergence: sig ? sig.divergence : (type === 'bottom' ? 'bullish' : 'bearish'),
        volRatio: sig ? sig.volRatio : 1.8,
        images,
      });
      if (r.ok) flash('ok', (type === 'bottom' ? '底部' : '顶部') + '测试通知已发送（含三模块一张截图）');
      else flash('err', '发送失败：' + (r.reason || r.error || '配置可能未启用/不完整'));
    } catch (e) { flash('err', '发送异常：' + e.message); }
    finally { setTesting(false); }
  };

  if (loading) return <div className="loading">加载配置中…</div>;

  return (
    <div>
      <div className="panel">
        <h3>🔔 企业微信信息发送配置</h3>
        {msg && (
          <div className="alert" style={{ background: msg.type === 'ok' ? '#e8f7ef' : '#fdecec', color: msg.type === 'ok' ? '#0e8a4f' : '#c0392b', border: '1px solid ' + (msg.type === 'ok' ? '#b7e4c7' : '#f5c2c2'), borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            {msg.text}
          </div>
        )}

        <div className="form">
          <label className="row2">
            <span>启用通知</span>
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          </label>
          <p className="muted" style={{ marginTop: -4 }}>关闭后，即使指标出现底部/顶部信号也不会发送任何消息。</p>

          <label className="row2">
            <span>发送方式</span>
            <select value={cfg.mode} onChange={(e) => set({ mode: e.target.value })} style={{ width: 220 }}>
              <option value="webhook">群机器人 Webhook（推荐）</option>
              <option value="app">自建应用消息</option>
            </select>
          </label>

          {cfg.mode === 'webhook' ? (
            <label className="row2 col">
              <span>群机器人 Key</span>
              <input value={cfg.webhook.key} onChange={(e) => setWebhook({ key: e.target.value })} placeholder="粘贴 Webhook 地址中 key= 后的内容" style={{ maxWidth: 460 }} />
              <small className="muted">在企业微信群 → 添加群机器人 → 查看 Webhook 地址，取 <code>key=</code> 之后的一段。</small>
            </label>
          ) : (
            <>
              <label className="row2 col">
                <span>企业ID corpid</span>
                <input value={cfg.app.corpid} onChange={(e) => setApp({ corpid: e.target.value })} placeholder="如 wwxxxxxxxx" style={{ maxWidth: 320 }} />
              </label>
              <label className="row2 col">
                <span>应用Secret</span>
                <input value={cfg.app.corpsecret} onChange={(e) => setApp({ corpsecret: e.target.value })} placeholder="应用管理页的 Secret" style={{ maxWidth: 460 }} />
              </label>
              <label className="row2 col">
                <span>应用AgentId</span>
                <input value={cfg.app.agentid} onChange={(e) => setApp({ agentid: e.target.value })} placeholder="如 1000002" style={{ maxWidth: 200 }} />
              </label>
              <label className="row2 col">
                <span>接收人 touser</span>
                <input value={cfg.app.touser} onChange={(e) => setApp({ touser: e.target.value })} placeholder="@all 或 企业微信账号" style={{ maxWidth: 320 }} />
                <small className="muted">@all 表示发给应用所有人；或填具体账号（如 HuangXuanXin）。</small>
              </label>
            </>
          )}

          <div className="sep" />

          <label className="row2">
            <span>📈 指标<strong>底部</strong>信号通知</span>
            <input type="checkbox" checked={cfg.notifyBottom} onChange={(e) => set({ notifyBottom: e.target.checked })} />
          </label>
          <label className="row2">
            <span>📉 指标<strong>顶部</strong>信号通知</span>
            <input type="checkbox" checked={cfg.notifyTop} onChange={(e) => set({ notifyTop: e.target.checked })} />
          </label>
          <p className="muted">开启后，当「当日分时主图」出现底部/顶部信号时按下方阈值自动推送企微（含三模块一张截图）；每条信号当天仅推送一次。</p>

          <div className="sep" />

          <label className="row2">
            <span>🎯 自动推送最低置信度</span>
            <select value={cfg.notifyMinConfidence || 'high'} onChange={(e) => set({ notifyMinConfidence: e.target.value })} style={{ width: 180 }}>
              <option value="high">高（乖离超阈 + 背离）</option>
              <option value="medium">中（仅乖离超阈）</option>
              <option value="low">低（含背离/全部）</option>
            </select>
          </label>
          <p className="muted">低于该置信度的顶/底信号不自动推送；手动「发送一天信号」不受此限。</p>
        </div>

        <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
          {!cfg.enabled && <span className="muted">（通知未启用，信号触发与测试均不会发送）</span>}
        </div>
      </div>

      {/* ===== 测试发送预览：当日分时 + 做T决策面板 + 当前分时形态概率匹配 三模块一张截图 ===== */}
      <div className="panel">
        <h3>🧪 测试发送预览</h3>
        <p className="muted">下方为测试通知实际抓取的内容（实时价格、当日均价、当日分时 + 做T决策面板 + 当前分时形态概率匹配 三模块一张截图）。点击「发送测试」将真实推送到企微。可修改代码查看不同标的。</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <input value={testCode} onChange={(e) => { const v = e.target.value.trim(); setTestCode(v); loadTest(v); }} style={{ width: 120 }} placeholder="代码如 sz002027" />
          <button className="btn" onClick={() => loadTest(testCode)}>载入</button>
          {tQuote && <span style={{ fontWeight: 700 }}>{tQuote.name}</span>}
          {tQuote && <span className={'bigprice ' + fmt.cls(tQuote.change_pct)} style={{ fontSize: 20 }}>{fmt.price(tQuote.price)}</span>}
          {tQuote && <span className={fmt.cls(tQuote.change_pct)}>{fmt.pct(tQuote.change_pct)}</span>}
        </div>
        <div style={{ background: '#f7f8fa', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
          <strong>将随通知发送：</strong> {lastInfo}
        </div>
        <div ref={testSnapRef} style={{ border: '1px solid #e3e6ea', borderRadius: 8, overflow: 'hidden' }}>
          <StockSnapshot code={testCode} name={testName} />
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => test('bottom')} disabled={testing || !cfg.enabled}>发送底部测试</button>
          <button className="btn" onClick={() => test('top')} disabled={testing || !cfg.enabled}>发送顶部测试</button>
          {!cfg.enabled && <span className="muted">（请先启用通知再测试）</span>}
        </div>
      </div>

      <div className="panel">
        <h3>📌 使用说明</h3>
        <ol className="muted" style={{ lineHeight: 1.8, margin: 0 }}>
          <li>在「实时看盘」页查看当日分时，下方副图为日内T指标，包含<strong>多方/空方力度</strong>、RSI、主力吸筹等。</li>
          <li>当<strong>当日分时主图</strong>出现<strong>底部</strong>或<strong>顶部</strong>高置信信号时，系统自动按此处配置推送企微消息（含实时价格、当日均价、当日分时 + 做T决策面板 + 当前分时形态概率匹配 三模块一张截图）。</li>
          <li>群机器人方式最简单，只需一个 Webhook Key，无需 access_token。</li>
          <li>同一信号在 15 秒一次的分时刷新中只会推送一次；换股票看盘会重新跟踪。</li>
          <li><strong>测试发送</strong>会使用上方预览标的的实时行情与图表，便于确认通知格式。</li>
        </ol>
      </div>
    </div>
  );
}
