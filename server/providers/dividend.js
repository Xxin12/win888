'use strict';
/**
 * 分红/转增数据获取(红利再投用)。
 * 数据源: 新浪财经分红融资页(公开、无鉴权, 与系统既有腾讯/新浪 provider 同源)。
 * 仅提取"实施"进度的分红事件, 返回每股口径(便于引擎直接乘持股数)。
 *
 * 返回示例:
 *   [{ exDate:'2026-07-09', cashPerShare:0.19, bonusPerShare:0, transferPerShare:0, progress:'实施' }, ...]
 */
const https = require('https');

function getBuffer(u) {
  return new Promise((res, rej) => {
    const req = https.get(u, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
      timeout: 10000,
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res(Buffer.concat(chunks)));
    });
    req.on('error', (e) => rej(e));
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// 解析新浪分红方案表。列顺序: 公告日期 / 送股(每10股) / 转增(每10股) / 派息税前(每10股,元) / 进度 / 除权除息日 / 股权登记日 / 红股上市日 / 查看
function parseSina(html) {
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]);
  const out = [];
  const seen = new Set();
  for (const t of tables) {
    if (!(t.includes('分红方案') || t.includes('分红年度'))) continue;
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
    for (const r of rows) {
      const c = [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
        .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (c.length < 8) continue;
      const exDate = c[5];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) continue; // 非数据行(表头/说明)
      const progress = c[4];
      if (progress !== '实施') continue; // 仅处理已实施的分红
      const bonus = parseFloat(c[1]) || 0;     // 送股(每10股)
      const transfer = parseFloat(c[2]) || 0; // 转增(每10股)
      const cash = parseFloat(c[3]) || 0;     // 派息税前(每10股, 元)
      const key = exDate + '|' + cash + '|' + bonus + '|' + transfer;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        exDate,
        cashPerShare: +(cash / 10).toFixed(6),
        bonusPerShare: +(bonus / 10).toFixed(6),
        transferPerShare: +(transfer / 10).toFixed(6),
        progress: '实施',
      });
    }
  }
  out.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  return out;
}

async function fetchDividend(rawCode) {
  const code = String(rawCode || '').replace(/^(sh|sz|bj)/i, ''); // 新浪用纯 6 位代码
  if (!/^\d{6}$/.test(code)) return [];
  const url = `https://money.finance.sina.com.cn/corp/go.php/vISSUE_ShareBonus/stockid/${code}.phtml`;
  const buf = await getBuffer(url);
  const html = new TextDecoder('gbk').decode(buf);
  return parseSina(html);
}

module.exports = { fetchDividend, parseSina };
