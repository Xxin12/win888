'use strict';
const wecom = require('../server/lib/wecom');
const content = [
  '大盘指数回补修复完成 ✅',
  '范围：行情中心 15 只大盘指数（仅行情中心边界）',
  '',
  '根因（两层）：',
  '① TDX 网关对指数代码返回「结构合法但数值损坏」序列且不抛错，脏数据直接落盘；',
  '② 东财兜底返回「ok:true 但 written:0」空成功，吞掉腾讯降级。',
  '',
  '修复：',
  '• 指数强制禁用 TDX（日线→腾讯、5分钟→新浪+腾讯实时）；',
  '• 分时主源改东财、腾讯当日分时兜底移到降级判断之外；',
  '• saveIntraday 新增严格日期/价格校验兜底拦截脏数据。',
  '',
  '验证：15 只指数 日线/5分钟/分时 全部 [OK]，',
  '全部数据正常(无垃圾): YES',
  '（日线 800 / 5分钟 1300 / 分时 242 点每只；',
  'bj899050 北证50 日线仅 1 根系腾讯源无深历史，正常非垃圾）',
].join('\n');
(async () => {
  const r = await wecom.sendText(content, { touser: 'huangxuanxin' });
  console.log('企微发送结果:', JSON.stringify(r));
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
