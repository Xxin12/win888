# 数据落盘 Fetcher (助手工作流)

Web 应用只读本地仓 + 后端直连腾讯实时接口。以下"历史/深度"数据由助手(WorkBuddy)通过 MCP 连接器拉取，归一化后写入 `data/`，作为离线兜底与深度补充。

## 5分钟历史 (通达信)
- 工具：`tdx-connector` 的 `tdx_kline(code, "5m", count)` 或分页 `tdx_api_data`。
- 归一化为 `data/stocks/<code>_5min.csv`，列：`datetime,date,open,high,low,close,volume,amount`。
- 说明：通达信是5分钟历史的权威源（腾讯公开接口仅近数日5分钟）。

## 日K (腾讯/通达信)
- `westock-mcp` 的 `data_kline(code,"day")` 或 `tdx_kline(code,"day")`。
- 写 `data/stocks/<code>_day.csv`，列：`date,open,high,low,close,volume`。

## F10/财务/资金流/新闻 (腾讯)
- `westock-mcp`：`data_finance / data_profile / data_shareholder / data_dividend / data_fund_flow / data_news / data_notice`。
- 分别写 `data/stocks/<code>_f10.json`、`<code>_fundflow.json`、`<code>_news.json`。

## 建议节奏
- EOD(收盘后)：刷新日K、5分钟增量、财务/资金流。
- 盘中：实时报价由后端直连，无需 MCP。
- 可配置每日 16:00 的自动化触发助手执行本工作流。

## 代码规范
统一带市场前缀：`sh`/`sz`/`bj` + 6位。例：分众传媒 = `sz002027`。
