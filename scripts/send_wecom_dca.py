import subprocess, json

node = r'C:\Users\miao\.workbuddy\binaries\node\versions\22.22.2\node.exe'
js = r'C:\Users\miao\.workbuddy\binaries\node\cli-connector-packages\node_modules\@wecom\cli\bin\wecom.js'

content = (
    "✅ 定投回测再次增强已完成并验证(分众传媒002027真实CSV)\n"
    "① 每期买入新增『按股数』设定: 买入方式(按金额/按股数), 按股数时每期固定股数(整百手强制整百), 加码倍率不生效, 隐藏余额结转。新增持股数指标。\n"
    "② 导入区新增『价格类型』下拉(前复权/除权原始): 本次你导入的是除权(原始)日线, 故截断与复权异常告警仅对前复权生效, 除权数据只做常规清洗并附中性说明。\n"
    "验证(14断言全过): qfq回归仍截断到2015-02-12/134期/含复权告警; 除权数据不截断(5197根全留); 按股数合成数据119期×100=11900股、每笔mul=1、投入=Σ(金额+费)。服务已常驻5178。"
)

payload = {
    "chat_type": 1,
    "chatid": "huangxuanxin",
    "msgtype": "text",
    "text": {"content": content},
}

r = subprocess.run([node, js, "msg", "send_message", "--json", json.dumps(payload, ensure_ascii=False)],
                   capture_output=True, encoding='utf-8', errors='replace')
print("RC=", r.returncode)
print("OUT=", (r.stdout or '').strip()[:600])
print("ERR=", (r.stderr or '').strip()[:600])
