# AGENTS.md — 工程约定

本仓库是 `dsh-kanweave`：一个同时作为 **独立 Web 应用** 和 **DeepSeek Harness 插件** 运行的项目管理产品。
任何自动化代理在改动前先读本文件。

## 硬性约束

1. **不要新增运行时依赖**。宿主进程可能只安装了本包自身（插件以 `link:` 方式安装）；`tsdown` 会把除 Cordis 外的代码全部打进 `lib/*.js`。数据库用内置 `node:sqlite`，HTTP 用 `node:http`，不要引入 express/fastify/ORM。
2. **Node 版本** `^22.19.0 || >=24.0.0`（`node:sqlite` 需要 ≥22.5）。
3. **分层**
   - `src/core/**`：协议类型、错误码、权限矩阵、媒体类型、Markdown 渲染——纯函数，不 import `node:*`、不碰 DOM。
   - `src/host/**`：只依赖 `src/core/**` + node 内置模块。
   - `src/client/**`（DSH 面板）、`src/standalone/**`（浏览器 SPA）：只依赖 `src/core/**`；不得 value-import `@deepseek-ai/*`（构建纯净度检查会失败），类型导入用 `import type`。
4. **契约优先**：请求/响应类型与路由常量只写在 `src/core/protocol.ts`；改接口必须同时改 UI 调用方与 `test/`。
5. **权限**：新增写接口必须在路由层调用 `requireRole`/`requireCardScope`，并在 `src/core/permissions.ts` 的 `MATRIX` 里补一行，同时更新测试。
6. **安全默认值**：Cookie `HttpOnly`+`SameSite=Lax`；写接口校验同源 `Origin`；插件形态默认只接受回环地址（`KW_ALLOW_LAN=1` 才放开，且操作员身份永远只在本机生效）；上传按文件头嗅探 MIME；错误信息不得泄露账号是否存在。

## 构建与测试

```bash
pnpm typecheck   # 必须零错误
pnpm test        # vitest，必须全绿
pnpm build       # tsc 产物由 tsdown 打包到 lib/
node scripts/check-client-bundle.mjs   # DSH 客户端包护栏，必须全绿
```

- `src/client/**` 只允许 `import type` 引用 `@deepseek-ai/*`；`react` / `react-dom` 必须保持 external。
  把它们打进 `lib/client.js`，面板在宿主里会拿到第二份 React，hook 抛 `Invalid hook call`，
  表现为「点侧边栏织板是空白」。面板组件还要求**不使用 hook**：即使将来打包配置退化，
  也只会丢加载提示，不会拖垮整个中间栏。
- 测试使用**真实 HTTP**（`createServer` + 临时 `dataDir`），不 mock 存储层；新接口至少覆盖：成功路径、权限拒绝、参数校验。
- 提交前跑 `pnpm typecheck && pnpm test && pnpm build && node scripts/check-client-bundle.mjs`。

## 变更习惯

- 中文注释可以，但面向公众的 README 用中文、代码标识符用英文。
- 数据迁移：`src/host/store.ts` 的 `SCHEMA_VERSION`/`migrate()` 里做增量迁移，禁止直接改历史 DDL。
- 破坏性协议变更要写进 `CHANGELOG.md`。
- 实时事件（`src/host/events.ts` + `routes.ts` 的 `serveEvents`）：任何写操作都会让项目 `revision` 递增并广播，因此**不要在写路径里手动发事件**；SSE 响应不得被缓冲，也必须在 `req/res` close 时退订，否则连接会泄漏。
