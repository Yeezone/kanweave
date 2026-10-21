# 安全说明

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的 [Security advisory](../../security/advisories/new) 私密报告，或发邮件给维护者；我们会在 7 天内回应，并在修复发布后致谢。

报告时请附：受影响版本、复现步骤、影响范围（例如「任意登录用户可读他人项目附件」）、以及你认为的严重程度。

## 支持的版本

| 版本 | 状态 |
| --- | --- |
| 0.1.x | 接收安全修复 |

## 部署方需要自己负责的部分

这个仓库提供应用本体，不提供托管服务。以下事项由部署方配置，配错会直接变成安全问题：

- **必须用 HTTPS 暴露到公网**。反代（Caddy/Nginx/Cloudflare Tunnel）负责证书；应用在 `KW_PUBLIC_URL` 为 `https://` 时会自动给会话 Cookie 加 `Secure`。
- **不要用 `KW_ALLOW_LAN=1` 暴露到公网**，它只是给局域网内网试用的开关；公网访问一律走独立站点形态（`node lib/standalone.js`）。
- **钉钉应用密钥**（`KW_DINGTALK_CLIENT_SECRET`）只放在服务器环境变量里，不要写进仓库、不要下发给前端。
- **首次部署后立刻创建管理员账号**，然后按需关闭自助注册：`KW_ALLOW_REGISTRATION=0`（注册出来的账号默认没有任何项目权限，但仍建议关掉）。
- **备份**：`data/` 目录（SQLite + `media/`）就是全部数据，按 [docs/deploy-cloud.md](docs/deploy-cloud.md) 的备份小节做定期快照。

## 已实现的安全默认值

- 会话 Cookie：`HttpOnly` + `SameSite=Lax`，HTTPS 下自动加 `Secure`；登录成功轮换会话 id。
- 写接口校验 `Origin`/`Sec-Fetch-Site`；插件形态默认只接受回环地址。
- 上传按文件头嗅探真实类型，扩展名白名单之外一律拒绝；附件下载对非内联类型加 `Content-Disposition: attachment` 与 `CSP: sandbox`。
- 钉钉身份绑定 `(corpId, unionId)`，登录参数 `state` 一次性消费，令牌只留在服务端。
- 权限在路由层强制（角色矩阵见 README），前端隐藏按钮只是体验，不作为安全边界。
