'use strict';
/**
 * TDX 网关端到端验证脚本 (直连网关, 不经 quant-web)。
 *
 * 用法:
 *   TDX_ENDPOINT=http://127.0.0.1:8899 TDX_TOKEN=your-secret \
 *     node test_client.js <code> <setcode> [startxh] [wantNum]
 *   例: node test_client.js 600031 1
 *
 * 校验点:
 *   - /healthz 通、pytdx 已装、已连上某节点
 *   - /kline 返回 rows, 字段含 time/price/volume/amount
 *   - 打印首尾几根 + 覆盖日期, 便于肉眼核对
 */
const ENDPOINT = (process.env.TDX_ENDPOINT || 'http://127.0.0.1:8899').replace(/\/+$/, '');
const TOKEN = (process.env.TDX_TOKEN || '').trim();
const [, , code = '600031', setcode = '1', startxh = '0', wantNum = '800'] = process.argv;

function headers() {
  const h = { 'User-Agent': 'tdx-gateway-test/1.0' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function main() {
  console.log(`[test] endpoint=${ENDPOINT} token=${TOKEN ? 'SET' : 'OFF'} code=${code} setcode=${setcode}`);

  // 1) 健康检查
  try {
    const hr = await fetch(`${ENDPOINT}/healthz`, { headers: headers() });
    console.log('[healthz]', hr.status, JSON.stringify(await hr.json()));
  } catch (e) {
    console.error('[healthz] 失败:', e.message, '\n  -> 网关没起来? 先 python tdx_gateway.py');
    process.exit(1);
  }

  // 2) 拉一页 K 线
  const url = `${ENDPOINT}/kline?code=${encodeURIComponent(code)}&setcode=${setcode}` +
    `&period=7&startxh=${startxh}&wantNum=${wantNum}&tqFlag=1`;
  let j;
  try {
    const r = await fetch(url, { headers: headers() });
    j = await r.json();
    console.log('[kline] HTTP', r.status, 'ok=', j.ok, 'cached=', !!j.cached, 'host=', j.host || '-');
  } catch (e) {
    console.error('[kline] 请求失败:', e.message);
    process.exit(1);
  }
  if (!j.ok) { console.error('[kline] 网关返回失败:', j.reason); process.exit(1); }

  const rows = j.rows || [];
  console.log(`[kline] rows=${rows.length}`);
  if (!rows.length) { console.warn('  (空: 可能非交易日/代码错/节点无数据)'); return; }

  // 3) 字段与覆盖核对
  const dates = [...new Set(rows.map((r) => String(r.time).slice(0, 10)))].sort();
  console.log('[kline] 覆盖日期:', dates.join(', '));
  const show = (r) => `${r.time}  price=${r.price}  vol=${r.volume}手  amt=${r.amount}元`;
  console.log('[kline] 头 3 根:'); rows.slice(0, 3).forEach((r) => console.log('   ', show(r)));
  console.log('[kline] 尾 3 根:'); rows.slice(-3).forEach((r) => console.log('   ', show(r)));

  const bad = rows.filter((r) => !r.time || r.price == null || r.volume == null || r.amount == null);
  if (bad.length) console.warn(`[warn] ${bad.length} 根字段缺失`);
  else console.log('[ok] 字段完整, 契约对齐 ✅');
}

main().catch((e) => { console.error(e); process.exit(1); });
