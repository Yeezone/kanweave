# KanWeave · 织板

[English](README.en.md) | **简体中文**

[![CI](https://github.com/Yeezone/kanweave/actions/workflows/ci.yml/badge.svg)](https://github.com/Yeezone/kanweave/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933.svg)](https://nodejs.org)

一个可以**自己部署、也可以装进 DeepSeek Harness**的项目管理产品：项目 → 栏目 → 卡片，卡片里能贴图、传视频、写 Markdown 评论；支持钉钉扫码登录、按项目邀请成员并设置管理员；多人同时看看板会实时同步。

零运行时 npm 依赖：数据库用 Node 内置的 `node:sqlite`，HTTP 用 `node:http`，构建产物是几个 `.js` 文件，拷到服务器上 `node lib/standalone.js` 就能跑。

![看板](docs/images/board.png)

## 功能

- **项目 / 栏目 / 卡片**：项目下自定义栏目（可排序），卡片可在栏目间拖动、排序、标记完成；每张卡片有项目内编号（如 `LAUNCH-12`）。
- **卡片详情**：优先级、截止日期、负责人、Markdown 描述（带安全预览）、评论区。
- **媒体附件**：图片、视频、音频、PDF、Office/压缩包；支持拖拽、粘贴上传、分片续传；视频用 `Range` 流式播放（可以拖进度条）。
- **实时协作**：SSE 推送项目变更与在线成员，顶部显示「N 人在看板」，断线自动退回轮询。
- **账号**：邮箱密码注册/登录、钉钉扫码登录（企业内部应用 OAuth2，按 `(corpId, unionId)` 绑定）、邀请链接自带注册。
- **权限**：项目级角色 —— 拥有者 / 管理员 / 成员 / 观察者；管理员可邀请成员，只有拥有者能转让/删除项目。
- **双形态**：独立 Web 站点（浏览器打开）+ DeepSeek Harness 侧边栏插件（同一个 UI，可指向云端同一个空间）。

![卡片详情](docs/images/card-drawer.png)

## 快速开始（本机 1 分钟）

需要 Node.js 24+（或 22.19+）和 pnpm。

```bash
git clone https://github.com/<your-account>/kanweave.git
cd kanweave
pnpm install
pnpm build
pnpm start            # http://localhost:4280/kanweave/ui/
```

首次打开会要求创建初始管理员账号，随后在左侧 `+` 新建项目即可。数据默认在 `./.data`（可用 `KW_DATA_DIR` 改）。

不想装 Node？用 Docker：

```bash
docker build -t kanweave .
docker run -d --name kanweave -p 4280:4280 -v kanweave-data:/data kanweave
```

## 部署给团队用（云端一份数据）

目标形态：**一台云服务器 + 一个域名**，任何设备打开同一个看板，DSH 插件也指向它。

```bash
cp .env.example .env      # 填 KW_PUBLIC_URL / 钉钉应用 / KW_DATA_DIR
docker compose up -d --build
# 反代（自动 HTTPS）
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

插件端只需一个文件让侧边栏面板连到云端：

```json
// ~/.dsh/kanweave/cloud.json
{ "url": "https://pm.example.com" }
```

完整步骤（服务器/域名、HTTPS、钉钉回调、备份升级、排错表）：

- [docs/deploy-cloud.md](docs/deploy-cloud.md) — Docker 一键部署（推荐）
- [docs/deploy-internet.md](docs/deploy-internet.md) — 裸机 systemd + Caddy/Nginx
- [docs/dingtalk.md](docs/dingtalk.md) — 钉钉应用配置与登录原理

## 装成 DeepSeek Harness 插件

```bash
# 方式一：脚本（写 profile 的依赖与 bundles，然后重启 DSH）
node scripts/install-dsh-plugin.mjs --profile desktop

# 方式二：命令行
dsh plugin --profile desktop add link:E:/Projects/ProjectEdit   # 换成你自己的仓库路径
```

重启 DeepSeek Harness 后，侧边栏出现「织板」入口，面板内就是完整的看板。卸载：`node scripts/install-dsh-plugin.mjs --profile desktop --remove`。

插件默认使用本机数据目录 `~/.dsh/kanweave`；配好 `cloud.json` 后改为转发到云端，本机不存项目数据（见 [docs/deploy-cloud.md](docs/deploy-cloud.md) 第 4 节）。

## 配置项（常用）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KW_PORT` / `KW_HOST` | `4280` / `127.0.0.1` | 独立站点监听地址 |
| `KW_DATA_DIR` | `./.data`（插件为 `~/.dsh/kanweave`） | SQLite + 附件目录 |
| `KW_PUBLIC_URL` | 空 | 公网地址；`https://` 开头会自动给会话 Cookie 加 `Secure` |
| `KW_COOKIE_SECURE` | 跟随 `KW_PUBLIC_URL` | 纯 HTTP 演示需显式设 `0` |
| `KW_MAX_ATTACHMENT_BYTES` | `1 GiB` | 单附件上限（反代要同步放宽） |
| `KW_ALLOW_REGISTRATION` | 开 | 自助注册；外网可关掉只留邀请链接 |
| `KW_CLOUD_URL` | 空 | 插件反向代理到云端部署的地址 |
| `KW_DINGTALK_CLIENT_ID` / `_CLIENT_SECRET` / `_CORP_ID` / `_REDIRECT_URI` | 空 | 钉钉扫码登录 |

完整清单见 [.env.example](.env.example)。

## 权限模型

| 动作 | 观察者 | 成员 | 管理员 | 拥有者 |
| --- | --- | --- | --- | --- |
| 查看项目 / 卡片 | ✅ | ✅ | ✅ | ✅ |
| 新建/编辑卡片、评论、上传附件 | ❌ | ✅ | ✅ | ✅ |
| 删除他人的卡片/评论/附件 | ❌ | ❌ | ✅ | ✅ |
| 管理栏目、项目设置 | ❌ | ❌ | ✅ | ✅ |
| 邀请成员、改角色 | ❌ | ❌ | ✅（不能授予管理员） | ✅ |
| 归档/删除项目、转让 | ❌ | ❌ | ❌ | ✅ |

## 架构

```
src/core/     协议类型、错误码、权限矩阵、媒体类型、Markdown 渲染（纯函数，浏览器可用）
src/host/     HTTP 路由、SQLite 存储、鉴权、钉钉 OAuth2、媒体存储、SSE、云端代理
src/client/   DeepSeek Harness 面板（React，iframe 承载同一个 SPA）
src/standalone/  浏览器 SPA（React，无框架依赖，构建成 public/app.js）
public/       SPA 外壳（index.html + CSS）
```

- 一份代码两副面孔：宿主插件提供 `/kanweave/*` 的 HTTP 与存储；浏览器 SPA 只依赖 `src/core` 的类型与纯函数。
- 接口契约集中在 `src/core/protocol.ts`，业务错误统一返回 HTTP 200 + `{ok:false,error:{code,message}}`。
- 数据是单实例单写入者：SQLite（WAL）+ `media/` 文件目录，备份就是复制这两样。

## 开发

```bash
pnpm typecheck                 # 零错误
pnpm test                      # vitest：真实 HTTP 集成测试 + 纯函数单测
pnpm build                     # tsdown 打包 lib/ 与 public/app.js，并跑客户端产物护栏
node scripts/smoke.mjs         # 起真实服务跑冒烟
node scripts/check-client-bundle.mjs
```

工程约定见 [AGENTS.md](AGENTS.md)；参与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题见 [SECURITY.md](SECURITY.md)。

## 已知边界

- 单实例部署，无多副本/共享数据库；实时事件是全量重取（几百张卡片规模可接受）。
- 钉钉仅用于登录，不同步通讯录；没有邮件通知、甘特图、工时。
- 附件存本地磁盘，未接对象存储。

## 许可

[Apache-2.0](LICENSE) © 2026 KanWeave contributors
