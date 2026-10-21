# Changelog

## 0.1.1 — 钉钉登录的文件配置（2026-10-21）

### 新增

- **`<数据目录>/dingtalk.json`**：服务端除 `KW_DINGTALK_*` 环境变量外，也读数据目录下的配置文件（环境变量优先）。字段同时接受钉钉控制台的 `appKey/appSecret` 与 OAuth2 的 `clientId/clientSecret`，支持 `"mock": true` 开启离线演示。桌面端由启动器拉起、不便设环境变量，用文件最省事。
- **`scripts/set-dingtalk.mjs`**：一条命令写入/查看/清除该配置（`--status` / `--mock` / `--app-key … --app-secret … --corp-id … --redirect-uri …` / `--clear` / `--data-dir`），文件权限 0600，输出打码后的密钥与重启提示。
- 文档补充「为什么插件里看不到钉钉按钮」的排查顺序（未配置凭据 / 不在登录页需点「登录其他账号」/ 重定向 URL 不一致 / 企业权限未批），并说明云端域名回调比本机随机端口更稳。

## 0.1.0 — 首个公开版本（2026-10-21）

首个开源版本：独立站点 + DeepSeek Harness 插件双形态、媒体附件、钉钉扫码登录、项目级权限与邀请、
多人实时协作，以及面向团队共用的云端代理模式。

### 新增 · 云端与开源

- **品牌更名**：ProjectEdit → **KanWeave（织板）**。路由前缀 `/kanweave`、环境变量前缀 `KW_`、
  数据目录 `~/.dsh/kanweave`、DSH 插件包名 `dsh-kanweave`、侧边栏入口「织板」。
  （升级提示：旧数据目录与旧 `PE_*` 变量需迁移，见 README。）
- 开源配套：`CONTRIBUTING.md`、`SECURITY.md`、`.gitattributes`、GitHub Actions CI（typecheck / test / build / smoke）。
- **云端共享模式**：设置 `KW_CLOUD_URL=https://pm.example.com` 或写 `<DSH_HOME>/kanweave/cloud.json`
  （`{"url": "https://pm.example.com"}`）后，插件进程把 `/kanweave/*` 同源反向代理到云端部署
  （新增 `src/host/cloud-proxy.ts`）。插件里的账号与看板就是团队成员浏览器里的同一份数据，
  关掉本机也不影响别人；`Set-Cookie` 会被改写成 `Path=/kanweave/`，插件侧保持一方 Cookie。
  代理是纯字节管道：分片上传、`Range` 下载、SSE 实时协作都能透传。
- 云端交付物：`Dockerfile`、`docker-compose.yml`、`deploy/Caddyfile`，以及
  `docs/deploy-cloud.md`（建站 → HTTPS → 钉钉回调 → 插件指向云端 → 备份升级 → 排错）。
- 新增 `test/cloud-proxy.test.ts`：用真实 upstream HTTP 服务验证路径改写、Cookie 改写、SSE 透传，
  以及云端不可达时返回 502 业务信封。

### 新增 · 核心功能

- 项目 / 栏目 / 卡片三级模型，栏目支持排序与 WIP 上限，卡片支持优先级、截止时间、指派人、完成状态、评论。
- 媒体附件：图片、视频、音频、PDF、Office 文档；粘贴/拖拽上传、分片续传、服务端 MIME 嗅探、`Range` 下载（视频可拖动）。
- 身份与权限：密码登录、项目级角色（所有者/管理员/成员/观察者）、邀请链接（过期时间 + 使用次数）、成员管理、操作审计。
- 邀请链接自助注册：未登录访客打开邀请链接即可创建账号并加入项目（`invites/accept` 接受可选 `name` / `email` / `password`），邮箱重复返回 `CONFLICT`，密码强度由服务端校验。
- 邮箱密码自助注册：`api/auth/register`（昵称 + 邮箱 + 密码），注册即登录且不带任何项目权限；受 `KW_ALLOW_REGISTRATION` 控制（默认开，`0/false/off` 关），关闭时返回 `FORBIDDEN`，UI 同步隐藏注册入口。
- 已注册用户目录：`api/users/search` 空查询返回最近注册账号（含钉钉自动建号者），项目「成员」页打开即列出候选，管理员勾选即邀请并设定角色。
- 卡片项目内编号：`cards.number`（迁移到 schema v2），看板与详情页显示 `项目键-编号`（如 `LAUNCH-12`），栏目内新建时按项目自增。
- 钉钉扫码登录（企业内部应用 OAuth2），按 `(corpId, unionId)` 绑定账号，另含仅开发可用的 mock 模式。
- 双形态运行：
  - 独立站点 `node lib/standalone.js`（默认 `http://localhost:4280/kanweave/ui/`）；
  - DeepSeek Harness 插件（侧边栏「织板」+ `kanweave_*` Agent 工具）。
- 实时协作：`GET api/events?projectId=…`（SSE）推送项目 `revision` 与在线成员 `presence`；看板收到事件后静默刷新，顶部显示「N 人在看板」，SSE 不可用时自动退化为 8 秒轮询。
- 插件形态「登录其他账号」：本机操作员可在面板内切换到某个项目成员账号，用于验证权限差异；新增 `KW_ALLOW_LAN=1` 允许局域网访问插件路由（访问者仍须是项目成员，操作员身份不外放）。
- 存储使用内置 `node:sqlite`，无原生依赖；附件以文件形式保存在数据目录。
- 公网部署：`KW_PUBLIC_URL`（https 开头会自动给会话 Cookie 加 `Secure`）、`KW_COOKIE_SECURE` 显式开关；新增 `docs/deploy-internet.md`（systemd + Caddy/Nginx + HTTPS + 钉钉回调 + 备份升级 + 排错速查）。
- `scripts/install-dsh-plugin.mjs --remove`：一条命令把本包从 profile 的依赖与 bundles 中摘掉，便于排查「某个插件装上后其他侧边栏条目消失」。
- 测试：真实 HTTP 集成测试（会话、权限、邀请、上传/Range、SSE 推送、HTTPS Cookie 标记）、权限矩阵单测、钉钉 mock 登录测试。

### 修复

- DSH 面板空白：客户端包把 React 一起打包进 `lib/client.js`，宿主渲染面板时拿到第二份 React，
  hook 抛 `Invalid hook call`，中间栏与侧边栏条目一起被卸载。现固定 `react`/`react-dom` 为
  external，包体 5.9 kB 且只 `require("react")`；面板组件改为纯元素（不含 hook），并新增
  `scripts/check-client-bundle.mjs` 作为构建护栏（模块加载握手、只依赖平台模块、不内联 React、无 hook）。
- 重建与页面加载并发：插件包 URL 带 `rev`（文件 mtime/size 哈希），在页面加载过程中重建会让
  旧 `rev` 的请求 404、侧栏入口暂时消失；README 与排错文档已注明「重建后刷新一次即可」。
- 插件市场元信息报错：`package.json` 声明了 `icon: "icon.svg"` 但仓库里没有该文件，DSH 插件
  页显示「包元信息错误: ENOENT lstat icon.svg」。现补上 `icon.svg`（看板+媒体卡片图标）与
  `LICENSE`（Apache-2.0），并按发布需要补齐 `files` / `peerDependencies`。

### 已知边界

- 单实例部署；无邮件通知、甘特图与工时。
- 钉钉仅用于登录，不同步通讯录。
- 实时事件不做增量补丁：收到 `revision` 后整板重取（几百张卡片规模下开销可忽略）。
