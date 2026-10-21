# 部署说明（独立站点形态）

## 本机 / 内网快速启动

```powershell
pnpm build
$env:KW_PORT    = '4280'
$env:KW_DATA_DIR = 'D:\kanweave-data'
node lib/standalone.js
```

打开 `http://<host>:4280/kanweave/ui/`，首次访问创建管理员。

## 反向代理（HTTPS 必须）

浏览器的 `Secure` Cookie 与钉钉回调都要求正式域名走 HTTPS。Nginx 示例：

```nginx
server {
  listen 443 ssl;
  server_name pm.example.com;

  # 附件默认上限 1 GiB，反代要放宽
  client_max_body_size 1100m;

  location / {
    proxy_pass http://127.0.0.1:4280;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 视频拖动依赖 Range 透传（Nginx 默认已透传，不要加 proxy_force_ranges 之外的改写）
    proxy_request_buffering off;
    # 实时协作走 SSE：必须关闭响应缓冲，否则看板要等连接结束才收到事件
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
  }
}
```

若前面还有 Cloudflare 之类的 CDN，需要给 `/kanweave/api/events` 关闭缓冲/压缩，
否则「多人同步」会退化成轮询（功能仍然可用，只是慢 8 秒）。

钉钉控制台的重定向 URL 与 `KW_DINGTALK_REDIRECT_URI` 都要改成
`https://pm.example.com/kanweave/api/auth/dingtalk/callback`。

## Windows 服务

```powershell
# 用任务计划或 nssm 注册为服务，示例（nssm）：
nssm install KanWeave "C:\Program Files\nodejs\node.exe" "E:\Projects\ProjectEdit\lib\standalone.js"
nssm set KanWeave AppEnvironmentExtra KW_PORT=4280 KW_DATA_DIR=D:\kanweave-data
nssm start KanWeave
```

## 备份与恢复

```powershell
# 停服后直接复制数据目录（SQLite + 附件）
Stop-Service KanWeave
Copy-Item -Recurse D:\kanweave-data E:\backup\kanweave-$(Get-Date -f yyyyMMdd)
Start-Service KanWeave
```

SQLite 使用 WAL，热备可直接复制 `kanweave.db*` 三个文件与 `media/` 目录；更稳妥的做法是停服冷备。

## 升级

1. 覆盖代码 → `pnpm install` → `pnpm build` → `pnpm test`。
2. 重启进程。数据库迁移在启动时自动执行（`src/host/store.ts`）。
3. 升级前先备份数据目录。

## 资源建议

- 20 人以内、附件存本地盘：2 vCPU / 2 GiB 内存足够；视频多时按附件体积预留磁盘。
- 单文件默认上限 1 GiB，可用 `KW_MAX_ATTACHMENT_BYTES` 调整，同时记得改反代的 `client_max_body_size`。
