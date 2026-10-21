# Deploy to the cloud (one shared space for the whole team)

Goal: **one cloud server + one domain** hosting the only project space. Any device — Windows, macOS, a phone browser, the DeepSeek Harness plugin — opens the same data with the same accounts, and shutting down your own laptop breaks nobody.

```
                     ┌──────────────────────────────┐
  any browser ──────▶│  https://pm.example.com      │
                     │  Caddy/Nginx → node          │   the only SQLite + media/
  DSH plugin panel ─▶│  /kanweave/* (local proxy)│
                     └──────────────────────────────┘
```

- **Cloud**: runs `lib/standalone.js`, owns SQLite and `media/` — the single source of truth.
- **DSH plugin**: the local process only *proxies* `/kanweave/*` to the cloud (`KW_CLOUD_URL`). The panel stays same-origin, so its cookie is first-party and the account in the plugin is exactly the account the person uses in a browser.
- Teammates can also open the cloud URL in any browser; the feature set is identical.

## 1. What you need

| Item | Notes |
| --- | --- |
| Cloud server | 1–2 vCPU, 1–2 GB RAM, 20 GB disk; Ubuntu 22.04/24.04 x86_64. Any VPS works |
| Domain | e.g. `pm.example.com`, A record to the server, **must serve HTTPS** (DingTalk callbacks require it, and the session cookie is `Secure`) |
| Network | allow inbound 80/443; do **not** expose 4280 publicly |
| DingTalk app | enterprise internal app; redirect URL `https://pm.example.com/kanweave/api/auth/dingtalk/callback` |

> Mainland-China hosting requires an ICP filing for the domain. Without one, use a Hong Kong/overseas VPS, or start with password signup and add DingTalk later.

## 2. Deploy with Docker (recommended)

```bash
git clone <your repo> kanweave && cd kanweave
cp .env.example .env            # edit the values below
docker compose up -d --build
docker compose logs -f          # wait for "listening on"
```

The compose file keeps data in a named volume and binds `127.0.0.1:4280` only — public traffic must go through the HTTPS reverse proxy.

### Reverse proxy (pick one)

**Caddy** (automatic certificates, simplest):

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # change the domain
sudo systemctl reload caddy
```

**Nginx** — three hard requirements:

1. `client_max_body_size 1100m;` (default attachment ceiling is 1 GiB)
2. `proxy_buffering off; proxy_cache off; proxy_read_timeout 3600s;` (live collaboration uses SSE; buffering makes the board feel stale)
3. Forward `X-Forwarded-Proto` and `X-Forwarded-Host` (same-origin checks and `Secure` cookies depend on them)

### Without Docker

Requires Node.js 24 (or 22.19+) and a build step; `lib/` + `public/` + `package.json` are the whole runtime — no `npm install` needed on the server.

```bash
pnpm install && pnpm build
sudo useradd --system --home /var/lib/kanweave kanweave
sudo rsync -a package.json lib public /opt/kanweave/
```

`/etc/systemd/system/kanweave.service`:

```ini
[Unit]
Description=KanWeave
After=network.target

[Service]
Type=simple
User=kanweave
Environment=KW_HOST=127.0.0.1
Environment=KW_PORT=4280
Environment=KW_DATA_DIR=/var/lib/kanweave
Environment=KW_PUBLIC_URL=https://pm.example.com
EnvironmentFile=-/etc/kanweave.env
ExecStart=/usr/bin/node /opt/kanweave/lib/standalone.js
Restart=always
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kanweave
```

## 3. Configuration (`.env`)

| Variable | Cloud value | Purpose |
| --- | --- | --- |
| `KW_HOST` | `0.0.0.0` in containers | Keep `127.0.0.1` on bare metal behind a proxy |
| `KW_PORT` | `4280` | |
| `KW_DATA_DIR` | `/data` | Database + attachments; **must** be a persistent volume |
| `KW_PUBLIC_URL` | `https://pm.example.com` | Marks the session cookie `Secure` automatically |
| `KW_COOKIE_SECURE` | leave empty | Only set `0` for a plain-HTTP intranet demo |
| `KW_ALLOW_REGISTRATION` | `1` initially | Teammates self-register; set `0` later to allow invite links only |
| `KW_MAX_ATTACHMENT_BYTES` | `1073741824` | 1 GiB default; raise it *and* the proxy limit for big videos |
| `KW_DINGTALK_CLIENT_ID` / `_CLIENT_SECRET` / `_CORP_ID` | from the DingTalk app | Without them the login page shows password only |
| `KW_DINGTALK_REDIRECT_URI` | `https://pm.example.com/kanweave/api/auth/dingtalk/callback` | Must match the DingTalk console byte for byte |

## 4. Point the DSH plugin at the cloud

By default the plugin serves its own local space (`~/.dsh/kanweave`). To show the cloud space instead, add one file:

```jsonc
// Windows: C:\Users\<you>\.dsh\kanweave\cloud.json
// macOS/Linux: ~/.dsh/kanweave/cloud.json
{ "url": "https://pm.example.com" }
```

Then **fully restart DeepSeek Harness** (a page refresh is not enough). After that:

- the sidebar 织板 (KanWeave) panel shows the cloud board, signed in with the same account (DingTalk QR or email/password);
- nothing is stored locally (local SQLite stays empty; `/kanweave/api/health` now reports the **cloud** instance);
- to switch back, delete `cloud.json` and restart.

`KW_CLOUD_URL=https://pm.example.com` as an environment variable works too. Precedence: explicit code option > `KW_CLOUD_URL` > `cloud.json`.

## 5. First run for a team

1. Open `https://pm.example.com/kanweave/ui/` and create the first account (email + password). That account bootstraps the instance.
2. Click `+` to create a project — it ships with three starter lists (To do / In progress / Done); add more as needed.
3. **Settings → Members** searches accounts that already registered; **Settings → Invites** produces a link that registers and joins in one step (role: viewer / member / admin).
4. Once everyone uses DingTalk, set `KW_ALLOW_REGISTRATION=0` and hand out invite links only.

## 6. Operations

- **Backup**: `sqlite3 /data/kanweave.sqlite "VACUUM INTO '/backup/kanweave-$(date +%F).sqlite'"` plus `tar czf /backup/media-$(date +%F).tar.gz /data/media`, on a cron.
- **Upgrade**: `git pull && docker compose up -d --build` (data stays in the volume); schema migrations run automatically on start.
- **Logs / health**: `docker compose logs -f --tail 200`, `curl -fsS https://pm.example.com/kanweave/api/health`.
- **Capacity**: 1 GiB per attachment by default; 20 GB is enough for a small team. Move `KW_DATA_DIR` to a data disk when videos pile up.

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Signed in, then immediately signed out | `Secure` cookie over plain HTTP; use HTTPS or set `KW_COOKIE_SECURE=0` temporarily |
| Write requests return 403 | Proxy is not forwarding `X-Forwarded-Host`, so the same-origin check fails |
| Upload returns 413 | Raise both `KW_MAX_ATTACHMENT_BYTES` and the proxy body limit (keep ~100 MB headroom) |
| Board is not live | SSE is buffered: `proxy_buffering off` + `proxy_read_timeout 3600s` |
| DingTalk reports `redirect_uri` mismatch | The callback must match the console exactly (scheme, host, path, no trailing slash) |
| Plugin shows the cloud but says signed out | Use the `127.0.0.1` DSH GUI; the cookie is rewritten to `/kanweave/` and only valid there |
| `SQLITE_BUSY` | Two writers on one data directory; run exactly one instance |
