# 部署到外网（给别人用）

本项目有两种形态，用途完全不同：

| 形态 | 监听地址 | 认证 | 适合谁 |
| --- | --- | --- | --- |
| DSH 插件（`dsh-kanweave`） | 跟随 DSH 的 `127.0.0.1:<DSH 端口>` | DSH 自身的登录 + 项目成员角色 | 只给你自己在这台机器上用 |
| 独立站点（`node lib/standalone.js`） | `KW_HOST:KW_PORT`（默认 `0.0.0.0:4280`） | 账号密码 / 钉钉扫码 + 项目成员角色 | **要让同事、客户在浏览器打开就用这个** |

> DSH 插件形态刻意只接受本机请求（`KW_ALLOW_LAN=1` 才放开局域网），并且 DSH 的 Web 端口本身需要一个访问令牌。
> 因此「部署到外网给其他人使用」= 部署**独立站点**，与 DSH 插件互不影响，两者可以同时在跑（数据目录分开即可）。

独立站点**没有任何运行时 npm 依赖**（数据库用 `node:sqlite`，HTTP 用 `node:http`），所以服务器上只需要 Node 24+ 和三样东西：

```
package.json      # 让 node 以 ESM 方式解析
lib/              # pnpm build 产物（index.js / standalone.js / client.js / service-*.js / ui-*.js）
public/           # index.html / app.js / app.css
```

不需要 `pnpm install`、不需要数据库服务、不需要 Redis。

---

## 1. 服务器准备

- 一台有公网 IP 的 Linux 服务器（1 vCPU / 2 GB 内存起步，`node:sqlite` 单进程即可）。
- 域名一条 A 记录，例如 `pm.example.com` → 服务器 IP。
- 开放 80 / 443（安全组 + 系统防火墙）。
- 安装 Node 24 LTS：

```bash
# Debian/Ubuntu 示例（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v24.x
```

把构建产物放到 `/opt/kanweave`（在开发机执行 `pnpm build` 后上传 `package.json lib public` 三样）：

```bash
sudo mkdir -p /opt/kanweave
# 本地：tar czf pe.tgz package.json lib public
# 上传后：tar xzf pe.tgz -C /opt/kanweave
```

## 2. 环境变量

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/kanweave.env
```

`/etc/kanweave.env`（逐项按需修改）：

```ini
# 只监听回环，公网入口交给反向代理（推荐）
KW_HOST=127.0.0.1
KW_PORT=4280

# 数据目录：SQLite 数据库 + media/ 附件，务必纳入备份
KW_DATA_DIR=/var/lib/kanweave

# 公开访问地址（https 开头会自动把会话 Cookie 标记 Secure）
KW_PUBLIC_URL=https://pm.example.com
KW_COOKIE_SECURE=1

# 单附件上限（字节，默认 1 GiB）
KW_MAX_ATTACHMENT_BYTES=1073741824

# 账号注册：外网暴露时建议关闭自助注册，只允许钉钉登录 + 邀请链接注册
KW_ALLOW_REGISTRATION=0

# 钉钉登录（企业内部应用）；REDIRECT_URI 必须与控制台里登记的完全一致
KW_DINGTALK_CLIENT_ID=dingxxxxxxxxxxxxxxxx
KW_DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
KW_DINGTALK_CORP_ID=dingxxxxxxxxxxxxxxxx
KW_DINGTALK_REDIRECT_URI=https://pm.example.com/kanweave/api/auth/dingtalk/callback
```

要点：

- `KW_COOKIE_SECURE` 不设时，只要 `KW_PUBLIC_URL` 是 `https://` 开头也会自动开启。
- `KW_ALLOW_REGISTRATION` 默认**开放**。开放也没关系（新账号看不到任何项目，必须被邀请），但如果只想让钉钉用户进来，就设 `0`；此时邀请链接仍然可以注册。
- 数据目录先建好并给运行用户写权限：

```bash
sudo mkdir -p /var/lib/kanweave && sudo chown -R kanweave:kanweave /var/lib/kanweave
```

## 3. 常驻进程（systemd）

```bash
sudo useradd --system --home /opt/kanweave --shell /usr/sbin/nologin kanweave
sudo chown -R kanweave:kanweave /opt/kanweave /var/lib/kanweave
```

`/etc/systemd/system/kanweave.service`：

```ini
[Unit]
Description=KanWeave
After=network.target

[Service]
Type=simple
User=kanweave
WorkingDirectory=/opt/kanweave
EnvironmentFile=/etc/kanweave.env
ExecStart=/usr/bin/node lib/standalone.js
Restart=always
RestartSec=3
# 上传大文件时会话与 SSE 都会占文件描述符
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kanweave
sudo systemctl status kanweave
curl -s http://127.0.0.1:4280/kanweave/api/health
```

健康检查返回 `{"ok":true,...,"mode":"standalone"}` 即成功。首次打开页面会出现「创建管理员」表单。

## 4. HTTPS 反向代理

三个硬性要求，缺一不可：

1. **转发 Host**（应用用 `Origin` / `X-Forwarded-Host` 做同源校验，不转发会 403）。
2. **关闭响应缓冲**（实时协作走 SSE，缓冲会让看板不刷新）。
3. **放宽请求体上限**（默认单附件 1 GiB）。

### Caddy（最省事，自动签发证书）

```caddyfile
pm.example.com {
	encode zstd gzip
	request_body {
		max_size 1100MB
	}
	reverse_proxy 127.0.0.1:4280 {
		flush_interval -1
		header_up X-Forwarded-Host {host}
	}
}
```

Caddy 默认就透传 `Host`，`flush_interval -1` 即关闭缓冲，SSE 可直接工作。

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name pm.example.com;

    ssl_certificate     /etc/letsencrypt/live/pm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pm.example.com/privkey.pem;

    # 单附件默认上限 1 GiB
    client_max_body_size 1100m;

    location / {
        proxy_pass http://127.0.0.1:4280;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 实时协作（SSE）：必须关闭缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;

        # 大文件上传：边收边发，避免整包落盘
        proxy_request_buffering off;
    }
}

server {
    listen 80;
    server_name pm.example.com;
    return 301 https://$host$request_uri;
}
```

> 若前面还有 CDN / 云 WAF，需要它对 `text/event-stream` 不缓冲，否则看板退回 8 秒轮询（功能仍在，只是不实时）。

## 5. 钉钉登录配置

1. [钉钉开放平台](https://open-dev.dingtalk.com/) → 应用开发 → **企业内部应用**（无需市场审核）。
2. 「登录与分享」→ 回调域名填写：

   ```
   https://pm.example.com/kanweave/api/auth/dingtalk/callback
   ```

   必须与 `KW_DINGTALK_REDIRECT_URI` **逐字节一致**（含协议、端口、末尾无斜杠差异）。
3. 申请权限：`Contact.User.Read`（读成员信息）。需要手机号再加 `Contact.User.mobile`。
4. 发布应用版本；只自己测试可选「仅我可见」。
5. 重启服务，页面上会出现「钉钉登录」按钮；扫码后自动建本地账号并登录。

安全约定（实现已内置，不要改坏）：

- 身份绑定 `(corpId, unionId)`，不按手机号/邮箱自动合并账号。
- `state` 一次性使用，先消费再换 token。
- 钉钉 userAccessToken 只存在服务端内存，不入 Cookie、不落库。

## 6. 邀请与权限（外网场景建议）

- 项目所有者/管理员 → 项目设置 → 成员 → 「添加已有用户」（从已注册账号里搜索）；
- 或「邀请」标签生成**邀请链接**发给对方：对方打开链接即可注册并加入（可设角色、有效期、使用次数）。
- 角色：所有者（唯一/转让）、管理员、成员、观察者（只读）。
- 建议外网部署时 `KW_ALLOW_REGISTRATION=0` + 钉钉登录 + 邀请链接，等于「公司内部人才能进」。

## 7. 备份与升级

```bash
# 冷备份（推荐，含附件）
sudo systemctl stop kanweave
sudo tar czf /backup/kanweave-$(date +%F).tgz -C /var/lib kanweave
sudo systemctl start kanweave

# 在线一致性备份数据库（SQLite）
sudo -u kanweave sqlite3 /var/lib/kanweave/kanweave.sqlite "VACUUM INTO '/backup/pe-$(date +%F).sqlite'"
```

- 要备份的只有 `KW_DATA_DIR`：`kanweave.sqlite`（账号/项目/卡片）+ `media/`（附件）。
- 升级：本地 `pnpm build` → 覆盖 `/opt/kanweave/lib` 与 `public` → `sudo systemctl restart kanweave`。数据库迁移在启动时自动执行（`PRAGMA user_version`）。

## 8. 没有公网 IP 怎么办

用一条隧道把本机 4280 暴露出去，钉钉回调同样填隧道域名：

```bash
# Cloudflare Tunnel 示例
cloudflared tunnel --url http://127.0.0.1:4280
# 或 frp / ngrok，把 https://xxx.example.com -> 127.0.0.1:4280
```

这种方式下 `KW_PUBLIC_URL=https://xxx.example.com`、`KW_COOKIE_SECURE=1` 仍然要设，否则会话 Cookie 不会带 Secure。

## 9. 排错速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一直跳回登录页 | Cookie 带了 `Secure` 但实际是 http | `KW_COOKIE_SECURE=0`（仅 http 调试） |
| 登录/保存接口 403「跨站请求被拒绝」 | 反代没转发 Host | 加 `proxy_set_header X-Forwarded-Host $host`（Caddy 默认已带） |
| 上传 413 | 反代 / CDN 限制 | `client_max_body_size 1100m` + CDN 放宽 |
| 看板不实时，但刷新后能看到 | SSE 被缓冲 | Nginx `proxy_buffering off` / Caddy `flush_interval -1` |
| 钉钉回调报 redirect_uri 不匹配 | 控制台与实际 URI 不一致 | 逐字节对齐，含 `https` 与端口 |
| 钉钉登录后看不到项目 | 新账号没有项目权限 | 管理员在「成员」里添加，或发邀请链接 |
| `SQLITE_BUSY` | 多进程同时写同一数据目录 | 一个数据目录只跑一个进程 |
