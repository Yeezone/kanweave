# 参与贡献

欢迎提 issue 和 PR。这个项目刻意保持「零运行时依赖」，所以请先读 [AGENTS.md](AGENTS.md) 的硬性约束。

## 开发环境

- Node.js `^22.19.0 || >=24.0.0`（`node:sqlite` 需要 ≥ 22.5）
- pnpm 11（`corepack enable` 或全局安装）

```bash
pnpm install
pnpm typecheck     # 必须零错误
pnpm test          # 必须全绿：真实 HTTP 集成测试 + 纯函数单测
pnpm build         # tsdown 打包 lib/ 与 public/app.js，同时跑客户端产物护栏
node scripts/smoke.mjs
```

提交前请把上面四条命令都跑一遍；CI 也会跑同样的门禁。

## 改动约定

- **接口契约集中在 `src/core/protocol.ts`**：加接口要同时改 UI 调用方和 `test/`。
- **权限**：写接口必须在路由层调用 `requireRole`/`requireCardScope`，并在 `src/core/permissions.ts` 的 `MATRIX` 里补一行，补测试。
- **数据迁移**：只允许在 `src/host/store.ts` 的 `SCHEMA_VERSION`/`migrate()` 里做增量迁移，不要改历史 DDL。
- **破坏性变更**写进 [CHANGELOG.md](CHANGELOG.md)。
- 面向用户的中文文案放 `src/standalone/locales.ts`（中文是源，英文镜像，键必须一一对应）。

## 提交 PR

1. Fork 并从 `main` 切分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 一个 PR 只做一件事；带测试；描述里写清「改了什么 / 为什么 / 怎么验证」。
3. 不要提交 `lib/`、`public/app.js`、`.data*`、`*.sqlite`（已在 `.gitignore` 里）。
4. 涉及界面改动的 PR，附一张改动前后的截图。

## 代码风格

- TypeScript strict，不引入运行时依赖；格式化交给编辑器（2 空格、单引号、无分号）。
- 中文注释可以，代码标识符一律英文。
