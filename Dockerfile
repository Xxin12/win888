# ============ 构建阶段：安装全部依赖并完成前端打包 ============
FROM node:22.22.2-slim AS builder

WORKDIR /app

# 仅复制清单先安装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 再复制源码并执行前端打包（输出到 server/public/app.js + index.html）
COPY . .
RUN npm run build

# ============ 运行阶段：最小化镜像 ============
FROM node:22.22.2-slim AS runtime

WORKDIR /app

# A股交易时段/收盘补齐调度依赖本地时区，必须装 tzdata 并设为上海
ENV TZ=Asia/Shanghai
# Node 22 内置 node:sqlite（实验特性），显式开启以保证容器内能正常加载
# （与本地开发环境 Node 22.22.2 行为一致；缺失此 flag 在部分 22.x 补丁版会无法 require）
ENV NODE_OPTIONS=--experimental-sqlite

RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

# 仅安装生产依赖（express + ws），不含 esbuild/react 等构建期依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制已打包的服务代码（含 server/public 构建产物）
COPY --from=builder /app/server ./server

# 容器统一监听 5178，可用 -e PORT=xxxx 覆盖
ENV PORT=5178
EXPOSE 5178

# 健康检查：Node22 自带 fetch，避免 slim 镜像缺 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:5178/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# data/ 通过卷挂载持久化（见 docker-compose），镜像内不打包任何数据
CMD ["node", "server/index.js"]

# ---------------------------------------------------------------------------
# 可选：启用「本地 TDX 网关」时需要 Python3 运行时（默认公开数据源不需要）。
# 如需启用，把上面运行阶段 FROM 之后加入：
#   USER root
#   RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
#       && pip3 install --no-cache-dir -r server/gateway/requirements.txt \
#       && rm -rf /var/lib/apt/lists/*
# 并在 docker-compose 中设置 TDX_ENDPOINT / TDX_TOKEN（或让其自动拉起本地网关）。
# ---------------------------------------------------------------------------
