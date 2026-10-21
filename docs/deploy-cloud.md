# 部署到云端（团队共用一块织板）

目标：**一台云服务器 + 一个域名** 承载唯一的织板。任何设备（Windows / Mac / 手机浏览器、DSH 插件）打开的
都是同一份数据、同一批账号；你自己的电脑关机不影响任何人。

```
                     ┌──────────────────────────────┐
  浏览器（任何人） ───▶│  https://pm.example.com      │
                     │  Nginx/Caddy → node          │  唯一数据库 + 附件目录
  DSH 插件面板 ──────▶│  /kanweave/*（本机转发）  │
                     └──────────────────────────────┘
```

- **云端**：跑 `lib/standalone.js`，拥有 SQLite + `media/`，是唯一事实来源。
- **DSH 插件**：本机进程只做**同源反向代理**（`KW_CLOUD_URL`），把 `/kanweave/*` 转发到云端。
  这样面板里的登录态和浏览器里的是同一个账号（Cookie 是一方 Cookie，不会被浏览器的三方 Cookie 策略拦掉）。
- 团队成员也可以在**任意浏览器**直接访问云端地址，功能完全一致。

## 1. 准备（你需要提供的东西）

| 项目 | 说明 |
| --- | --- |
| 云服务器 | 1–2 vCPU / 1–2 GB 内存 / 20 GB 系统盘即可；Ubuntu 22.04/24.04 x86_64。阿里云/腾讯云轻量、或海外 VPS 都行 |
| 域名 | 例如 `pm.example.com`，A 记录指向服务器公网 IP；**必须能上 HTTPS**（钉钉回调要求 HTTPS，Cookie 的 `Secure` 也要求 HTTPS） |
| 端口 | 安全组放行 80/443；不要对公网暴露 4280 |
| 钉钉应用 | 企业内部应用，回调地址填 `https://pm.example.com/kanweave/api/auth/dingtalk/callback` |

> 服务器放在中国大陆需要域名备案（ICP）；没有备案就用香港/海外节点，或先用「账号密码注册」跑起来，钉钉登录后补。

## 2. 部署（Docker，推荐）

```bash
# 服务器上
git clone <你的仓库> kanweave && cd kanweave   # 或把本地仓库 rsync 上来
cp .env.example .env                                # 按需改下面几个值
docker compose up -d --build
docker compose logs -f                              # 看到 listening on 就成功
```

`docker-compose.yml` 已经把数据放在命名卷里、只监听 `127.0.0.1:4280`，公网流量必须经过 HTTPS 反代。

### 2b. 反代（二选一）

**Caddy**（自动申请证书，最省事）：

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # 改成你的域名
sudo systemctl reload caddy
```

**Nginx**：见 `docs/deploy.md` 里的 `location /kanweave/` 段，注意三条硬性要求：

1. `client_max_body_size 1100m;`（附件默认上限 1 GiB）
2. `proxy_buffering off; proxy_cache off; proxy_read_timeout 3600s;`（实时协作走 SSE，缓冲会让看板"不实时"）
3. 透传 `X-Forwarded-Proto` / `X-Forwarded-Host`（同源校验和 `Secure` Cookie 依赖它）

## 3. 配置项（`.env`）

| 变量 | 云端建议值 | 说明 |
| --- | --- | --- |
| `KW_HOST` | `0.0.0.0`（容器内） | 裸机直接跑时保持 `127.0.0.1`，交给反代 |
| `KW_PORT` | `4280` | |
| `KW_DATA_DIR` | `/data` | 数据库 + 附件；**必须**在持久卷上 |
| `KW_PUBLIC_URL` | `https://pm.example.com` | 自动把会话 Cookie 标成 `Secure` |
| `KW_COOKIE_SECURE` | 留空（自动） | 只有纯 HTTP 内网演示才设 `0` |
| `KW_ALLOW_REGISTRATION` | `1`（先开放） |  teammates 自助注册；稳定后可设 `0`，改成只发邀请链接 |
| `KW_MAX_ATTACHMENT_BYTES` | `1073741824` | 默认 1 GiB；视频大就调大，同时改反代上限 |
| `KW_DINGTALK_CLIENT_ID` / `_CLIENT_SECRET` / `_CORP_ID` | 钉钉应用的值 | 不配则登录页只显示账号密码 |
| `KW_DINGTALK_REDIRECT_URI` | `https://pm.example.com/kanweave/api/auth/dingtalk/callback` | 必须与钉钉后台**逐字符一致** |

## 4. 让 DSH 插件指向云端

插件默认是自己本机 `~/.dsh/kanweave` 的独立空间。要让插件看到云端那一个空间，只加一个文件：

```jsonc
// Windows: C:\Users\<你>\.dsh\kanweave\cloud.json
// macOS/Linux: ~/.dsh/kanweave/cloud.json
{ "url": "https://pm.example.com" }
```

写入后**完整重启 DeepSeek Harness**（不是刷新页面）。生效后：

- 侧边栏「织板」面板里就是云端看板，登录用同一个账号（钉钉扫码或邮箱密码）；
- 本机不再保存任何项目数据（本地 SQLite 保持空库；`/kanweave/api/health` 现在返回的是**云端**实例的健康信息）；
- 想切回本机模式：删除 `cloud.json` 再重启。

也可以用环境变量 `KW_CLOUD_URL=https://pm.example.com` 启动 DeepSeek Harness，效果相同。优先级：代码显式传入的参数 > `KW_CLOUD_URL` 环境变量 > `cloud.json` 文件。

## 5. 团队第一次使用

1. 部署完先打开 `https://pm.example.com/kanweave/ui/`，用邮箱+密码**创建第一个账号**（第一个账号自动成为该实例的初始管理员，仅用于开局）。
2. 左侧 `+` 新建项目 → 项目里自带「待办 / 进行中 / 已完成」三个栏目，可继续加栏目。
3. 「设置 → 成员」里按姓名/邮箱搜索**已注册用户**并添加；「设置 → 邀请」生成邀请链接，对方打开链接即可注册并加入（角色可选 观察者/成员/管理员）。
4. 全员改用钉钉登录后，可把 `KW_ALLOW_REGISTRATION=0` 关掉自助注册，只保留邀请链接。

## 6. 运维

- **备份**：`sqlite3 /data/kanweave.sqlite "VACUUM INTO '/backup/kanweave-$(date +%F).sqlite'"` + `tar czf /backup/media-$(date +%F).tar.gz /data/media`，放进 cron。
- **升级**：`git pull && docker compose up -d --build`（数据在卷里，不受影响）；数据库结构升级由服务启动时自动迁移。
- **日志**：`docker compose logs -f --tail 200`；健康检查 `curl -fsS https://pm.example.com/kanweave/api/health`。
- **容量**：附件默认每个 1 GiB，20 GB 盘只适合小团队；视频多就挂独立数据盘（改 `KW_DATA_DIR`）。

## 7. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 登录后立刻退出 | 用 HTTP 打开但 Cookie 是 `Secure`；确认域名走 HTTPS，或临时 `KW_COOKIE_SECURE=0` |
| 写操作返回 403 | 反代没透传 `X-Forwarded-Host`/`Origin` 不一致；按上面 Nginx 段配置 |
| 上传 413 | `KW_MAX_ATTACHMENT_BYTES` 与反代 `client_max_body_size` 至少差 100 MB |
| 看板不实时 | SSE 被反代缓冲：`proxy_buffering off` + `proxy_read_timeout 3600s` |
| 钉钉登录报 `redirect_uri` 不匹配 | 回调地址必须与钉钉后台完全一致（含协议、端口、尾部无斜杠） |
| 插件面板显示云端但提示未登录 | 插件侧 Cookie 是按 `/kanweave/` 重写的，确认访问的是 `127.0.0.1` 的 DSH GUI，且 `cloud.json` 的域名与云端一致 |
| `SQLITE_BUSY` | 不要在容器外再挂载数据库做写入；只允许一个实例写同一个数据目录 |
