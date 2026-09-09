const wecom = require('C:/Users/miao/Desktop/W888/quant-web/server/lib/wecom.js');
const content = `✅ 量化系统·策略回测「手动买卖点」改为公式化全日期回测

变更语义：手动买卖点不再只回测点选当天，而是把点选的买卖点当「锚点」，用 锚点价/当时均价 推导通用公式：
- 买入比 rBuy = 买点.price/买点.avg
- 卖出比 rSell = 卖点.price/卖点.avg
再对股票【全部分时日期】逐日应用公式回测（T+0，每日一笔配对，收盘前强制平仓）。

改动：
- server/backtest/manual.js：新增 deriveFormula + runManualBacktest（覆盖 intraday.listDates 全部日期，含 k5 回退均价）。
- server/backtest/engine.js：manual 分支改走公式回测，返回 formula/meta(评估日/触发日/总数)。
- 前端：点击时带出「当时均价 avg」；说明与按钮改为「用公式回测全部分时日期」；结果展示推导公式与覆盖交易日数。

验证(HTTP 端到端)：以 sz000001 锚点推导 rBuy=0.9994/rSell=1.0014，回测 93 个分时日、触发 85 日共 128 笔，绩效/明细/覆盖日期均正常。服务已重启 http://localhost:5178。`;
wecom.sendText(content, { touser: 'huangxuanxin' }).then((r) => {
  console.log('sendText result:', JSON.stringify(r));
  process.exit(0);
}).catch((e) => { console.error('ERR', e); process.exit(1); });
