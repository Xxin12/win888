# 量化系统（quant-web）Docker 部署方案

> 目标：把本地单机版 quant-web 容器化，便于在任意装了 Docker 的机器上一键部署，
> 同时保证 SQLite 数据（约 2.3GB）持久化、A股交易时段调度时区正确、WebSocket 正常。

## 一、架构与镜像设计

采用**多阶段构建**：

| 阶段 | 基础镜像 | 作用 | 产出 |
|------|----------|------|------|
| builder | `node:22-slim` | `npm ci` 安装全部依赖 → `npm run build` 打包前端 | `server/public/app.js` + `index.html` |
| runtime | `node:22-slim` | 仅 `npm ci --omit=dev`（express + ws）→ 复制 builder 的 `server/` | 最终运行镜像 |

- **为什么用 `node:22-slim`**：项目依赖 Node ≥22 的 `node:sqlite`（内置、实验特性），22-slim 基于 Debian glibc，与本机开发环境一致，避免 alpine/musl 的潜在坑。
- **运行时不需要 Python**：默认数据源为腾讯（实时/分时）、新浪（5分历史）、东财（日K/历史分时），均为 HTTP 公开接口，容器内纯 Node 即可。
- **TDX 网关为可选**：仅当需要用「本地 TDX 网关」做多月历史深度回溯时才需 Python3 + `pytdx/fastapi/uvicorn`。Dockerfile 末尾保留了开启该能力的注释块，`docker-compose.yml` 里也留了 `TDX_ENDPOINT/TDX_TOKEN` 占位。

## 二、必须关注的三个坑

1. **数据持久化（最重要）**
   - `data/` 约 2.3GB（1085 个 SQLite 文件 + `wecom-config.json`），**绝不能 `COPY` 进镜像**。
   - `.dockerignore` 已exclude `data`、`*.db`、`backups` 等；compose 用 `./data:/app/data` 绑定挂载。
   - 已有本机数据可直接复用：把 `quant-web/data` 挂进去即可，首次启动若无数据会自动建表/惰性创建。

2. **时区 `TZ=Asia/Shanghai`**
   - 服务内的「收盘后数据补齐调度器」按本地时间判定 `>=15:10`，容器内默认 UTC 会导致调度错位一整天。
   - 运行阶段已 `apt-get install tzdata` 并设置 `TZ=Asia/Shanghai`（windowsslim 镜像默认缺 tz 数据库，必须装）。

3. **WebSocket 与外部访问**
   - 直连 `http://<host>:5178` 即可，WS `/ws/quotes` 同源升级，无需额外配置。
   - 若要走域名 + HTTPS，需在前端加反向代理并放行 WS 升级（见第四节 nginx 片段）。

## 三、构建与运行

```bash
# 1) 构建并后台启动（首次会从网络拉 npm 依赖并打包前端，稍慢）
docker compose up -d --build

# 2) 查看状态 / 日志
docker compose ps
docker compose logs -f quant-web

# 3) 访问
#    浏览器打开 http://<宿主机IP>:5178
#    健康检查：docker inspect --format '{{.State.Health.Status}}' quant-web
```

常用运维：

```bash
# 停止 / 重启 / 卸载（数据仍在宿主机 ./data，不会丢）
docker compose stop
docker compose restart
docker compose down        # 仅删容器，数据卷保留

# 升级（改完代码后重建）
docker compose up -d --build
```

## 四、反向代理（可选，域名 + HTTPS）

若用 nginx 对外暴露，需放行 WebSocket 升级。样例 `nginx.conf` 片段：

```nginx
server {
    listen 443 ssl;
    server_name quant.example.com;

    location / {
        proxy_pass http://127.0.0.1:5178;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;        # WS 升级
        proxy_set_header Connection "upgrade";         # WS 升级
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;                      # 实时推送长连接
    }
}
```

## 五、启用本地 TDX 网关（可选）

1. 编辑 `Dockerfile`：取消运行阶段里「可选 Python3」注释块（`apt-get install python3 python3-pip` + `pip3 install -r server/gateway/requirements.txt`）。
2. 在 `docker-compose.yml` 设置 `TDX_ENDPOINT`（如 `http://127.0.0.1:10000`）与 `TDX_TOKEN`，或在 `gateway/gateway.config.json` 配置本地自动拉起。
3. compose 已设 `init: true`（tini），可正确回收 TDX 的 Python 子进程，避免僵尸进程。

## 六、资源与权限建议

- **资源限制**：回补任务较重，建议在 compose `deploy.resources.limits` 限制 CPU/内存（已留注释占位）。
- **权限**：默认容器以 root 运行即可（本地量化工具场景）；若需降权，可在运行阶段 `USER node` 并确保 `/app/data` 挂载可写。
- **备份**：`data/` 即全部状态，定期 `tar` 打包或挂载到带快照的卷即可备份。

## 七、本地已运行的实例说明

当前 Windows 本机已有一个直接运行的实例（PID 5088，端口 5178）。
容器化部署与其实例**端口冲突**，请勿在同一台机器同时跑两者；
迁移到 Docker 时可直接把本机 `quant-web/data` 作为卷挂载，数据无缝沿用。
