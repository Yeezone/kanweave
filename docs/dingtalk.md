# 钉钉登录接入说明

KanWeave 用**企业内部应用 + OAuth2 授权码换用户令牌**完成扫码登录。实现集中在 `src/host/dingtalk.ts`，路由在 `src/host/routes.ts` 的 `api/auth/dingtalk/*`。

> 在产品中的定位：钉钉登录同时承担**注册**。首次扫码会自动创建本地账号（昵称/头像/邮箱取自钉钉资料，`kind='dingtalk'`，按 `(corpId, unionId)` 绑定），账号本身没有任何项目权限；之后由项目管理员在「成员 → 添加已有用户」里把该账号邀请进项目。

## 控制台配置

1. [开放平台](https://open-dev.dingtalk.com/) → 创建**企业内部应用**（不需要上架审核）。
2. 记录 **AppKey / AppSecret / CorpId**。
3. 「登录与分享」→ 重定向 URL 填：

   ```
   http://localhost:4280/kanweave/api/auth/dingtalk/callback
   ```

   - 钉钉官方支持 `http://localhost`（其教程示例就是 `http://localhost:5173`），**不需要**内网穿透（官方穿透服务已于 2022-07-21 下线）。
   - 换端口/域名时，控制台与 `KW_DINGTALK_REDIRECT_URI` 必须逐字节一致。
4. 权限点：`Contact.User.Read`（成员信息读权限）；需要手机号再加 `Contact.User.mobile`。这些权限需要企业管理员在后台同意。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `KW_DINGTALK_CLIENT_ID` | AppKey |
| `KW_DINGTALK_CLIENT_SECRET` | AppSecret（仅服务端使用，绝不返回给浏览器） |
| `KW_DINGTALK_CORP_ID` | 企业 CorpId；用于校验令牌归属 |
| `KW_DINGTALK_REDIRECT_URI` | 与控制台填写的重定向 URL 完全一致 |
| `KW_DINGTALK_MOCK` | `1` 时启用演示登录（立即通过、生成演示账号）；生产环境请勿开启 |

## 流程

```
浏览器                     KanWeave                     钉钉
  │ GET api/auth/dingtalk/start │                            │
  │────────────────────────────>│ 生成 state+nonce，落库     │
  │<── { url, pendingId } ──────│                            │
  │ 打开 url ───────────────────────────────────────────────>│ 扫码授权
  │<──── 302 callback?authCode=…&state=… ────────────────────│
  │ GET /api/auth/dingtalk/callback（服务端）                │
  │                             │ 校验 state（一次性）───────>│
  │                             │ POST /v1.0/oauth2/userAccessToken
  │                             │ GET  /v1.0/contact/users/me
  │                             │ 按 (corpId, unionId) upsert 用户
  │<──── 302 到落地页?pending=… │                            │
  │ POST api/auth/dingtalk/poll │                            │
  │────────────────────────────>│ 返回 status=approved + Set-Cookie
```

关键实现细节：

- `state` 与 `nonce` 在**换取令牌之前**标记为已使用（防重放）；用 `crypto.timingSafeEqual` 比较。
- 用户唯一键是 **`(corpId, unionId)`**。不要用 `mobile`、`email`（管理员可改）、`openId`（应用级，换应用会变）、`userid`（企业内唯一但可改）做账号主键。
- 授权码有两种、端点不同，**不能混用**：
  - 扫码/OAuth2：`authCode` → `POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken`
  - 钉钉容器内 JSAPI 免登 `dd.requestAuthCode` 的 code → `POST https://oapi.dingtalk.com/topapi/v2/user/getuserinfo`
- `users/me` 的请求头是 `x-acs-dingtalk-access-token: <token>`，**没有** `Bearer` 前缀。
- 用户令牌（7200s）只留在服务端内存/请求上下文，不写 Cookie、不写 localStorage；登录场景不持久化 30 天 refreshToken。
- 首次钉钉登录会**新建**本地账号，不会按手机号/邮箱自动合并到已有账号，避免账号被冒领。
- 登录成功后轮换 session id。

## 本地联调

```powershell
$env:KW_DINGTALK_MOCK = '1'
node lib/standalone.js
```

登录页点「钉钉登录」会立即完成并落到一个 `kind=dingtalk` 的演示账号。mock 只在明确置位时生效，且不依赖任何网络请求。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| 回调页 400「登录状态无效或已过期」 | `state` 不存在 / 已用过 / 超过 6 分钟；或浏览器与服务端不是同一个实例 |
| 400 `invalidClientIdOrSecret` | AppKey/AppSecret 不匹配，或误用了其它应用的密钥 |
| 404 `invalidParameter.user.notFound` | 用户不在该企业内 |
| 授权页提示重定向地址不合法 | 控制台 URL 与 `KW_DINGTALK_REDIRECT_URI` 不一致（含端口、末尾斜杠） |
| 扫码后一直 pending | 回调没有到达服务端（反代没转发 `/kanweave/api/auth/dingtalk/callback`） |
