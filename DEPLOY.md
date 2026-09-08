# 围之象棋联机版部署

本项目已提供网页、联机服务器和 Docker 配置。基于 Node.js 22+ 内置 SQLite 模块，无需额外构建步骤或第三方 npm 运行依赖。使用一个服务进程即可管理双人房（默认上限 5 间，可由管理员调整）。

## 方式一：直接运行 Node.js

服务器安装 Node.js 22 或更高版本，把整个项目复制到服务器目录，例如 `/opt/xiangqi-go`：

```sh
cd /opt/xiangqi-go
npm test
HOST=0.0.0.0 PORT=5173 npm start
```

浏览器访问 `http://服务器IP:5173`。服务器防火墙和云安全组需要允许你选用的端口。Windows PowerShell 启动方式：

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '5173'
npm start
```

默认 `HOST=0.0.0.0`、`PORT=5173`。长期运行建议使用下面的 Docker 自动重启方式，或配置系统服务。

## 方式二：Docker Compose

服务器安装 Docker Engine 与 Compose 插件后，在项目目录运行：

```sh
docker compose up -d --build
docker compose logs -f
```

默认映射宿主机 `5173` 端口。数据持久化保存在挂载的 `account-data` 卷（映射容器内 `/app/data`）中。容器内以非 root 用户运行，自带 `/health` 健康检查。

更新代码后再次执行 `docker compose up -d --build`。更新会重启服务，当前进行中的房间会清空，但所有用户账号、密码凭据、会话、服务器设置和对局归档均持久保存在 SQLite 数据库中。

## 域名与 HTTPS 反向代理

推荐在公网服务前使用 Nginx 提供 HTTPS 与反向代理：

```nginx
server {
    listen 80;
    server_name game.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name game.example.com;

    ssl_certificate /etc/letsencrypt/live/game.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 75s;
    }
}
```

**反向代理关键配置说明**：
- 联机使用 **HTTP POST + SSE 长连接**，不是 WebSocket。必须关闭代理缓冲（`proxy_buffering off;`），让落子与棋局状态及时推送到浏览器；服务器每 10 秒发送一次心跳。
- **代理 IP 信任**：生产环境中若位于反向代理之后，请在服务环境或 `.env` 中配置 `TRUSTED_PROXIES=127.0.0.1,::1`（填写真实前置反向代理 IP）。服务仅在请求来源为受信代理时才采纳 `X-Forwarded-For`，防止客户端恶意伪造代理头绕过限流。
- **公网来源校验**：配置 `PUBLIC_ORIGIN=https://game.example.com`，服务端将严格核对请求的 `Origin` / `Referer`，拒绝任何跨站非法请求。

## 数据存储与 SQLite 迁移

1. **SQLite 存储架构**：
   - 采用 Node.js 22 内置 `node:sqlite`（WAL 模式 + 外键约束），无第三方 npm 驱动。
   - 默认数据库文件位于 `./data/xiangqi.db`（可通过 `DATABASE_PATH` 环境变量指定）。
   - 账号、密码哈希、会话、游客凭据、对局档案、参赛关系、服务器设置和审计日志均结构化分表存储，支持服务端分页查询与索引检索。

2. **旧版 users.json 迁移流程**：
   - 服务启动时若检测到未迁移的 `users.json`（支持旧版数组格式及 users/settings/matches 对象格式），会自动执行事务化迁移：
     1. 自动生成备份文件 `users.json.bak.<时间戳>`。
     2. 开启 SQLite 事务，批量导入用户、密码哈希、游客设备关联、服务器设置与历史对战，并建立外键索引。
     3. 校验导入数量与关键字段；若校验失败则立即自动回滚事务，保留原状并提示。
     4. 迁移成功后在数据库记录迁移哈希，避免后续重复导入。
     5. 原始 `users.json` 和备份文件均会安全保留，不会被自动删除。
   - 也可通过命令行手动执行迁移：`node users.js --migrate`。

3. **数据备份与恢复**：
   - **备份**：备份 `data/xiangqi.db`（若处于运行中，可直接复制或执行 `sqlite3 .dump` / PRAGMA wal_checkpoint）以及本地环境配置文件 `.env`。
   - **回滚**：如需回退到旧版 JSON 数据，可直接利用备份的 `users.json.bak.<时间戳>` 还原为 `users.json`。

## 安全与会话机制

1. **服务端安全会话**：
   - 前端彻底废除本地保存或加密密码的逻辑，不在 localStorage / sessionStorage 保存任何密码或可还原密码的数据。
   - 用户登录后由服务端签发高熵会话令牌，浏览器通过 `HttpOnly; SameSite=Lax; Path=/` Cookie 自动携带（生产 HTTPS 环境自动启用 `Secure`）。
   - 数据库仅存储会话令牌的 SHA-256 哈希值，不存储原始令牌。
   - 会话设置 7 天空闲超时与 30 天绝对有效期，注销、密码重置、账号删除或权限变更时服务端立即吊销对应活跃会话。

2. **CSRF 双重防御**：
   - 所有变更类请求（POST）在服务端逐一校验 `Origin` / `Referer` 白名单。
   - 针对使用 Cookie 鉴权的浏览器请求，强制要求携带与会话绑定的 `X-CSRF-Token` 头，双重拦截跨站伪造请求。

3. **游客凭据机制**：
   - 禁止使用客户端 IP 地址作为游客凭据或身份回退。
   - 服务端生成高熵随机游客凭据，不同浏览器上下文获得独立身份；同一浏览器持有有效凭据可恢复原游客。
   - 游客账号可在个人资料中一键升级为正式注册账号，完好保留既有对局档案与胜率。

4. **密码与管理员安全**：
   - 密码哈希采用异步 `scrypt` 方案，显式记录成本参数（`N=16384, r=8, p=1, keyLen=64`）与算法版本，不阻塞主事件循环。
   - 生产环境（`NODE_ENV=production`）严禁使用默认管理员密码（`admin123`），否则服务将拒绝启动。
   - 支持通过安全命令行初始化或重置管理员凭据：`node users.js --reset-admin`。
   - 采用默认拒绝的权限策略，缺失权限字段默认为空；敏感操作（删除账号、重置他人密码、变更管理员角色）需输入当前管理员密码二次认证，并完整记录审计日志（`GET /api/admin/audit-logs`）。

5. **隐私与数据生命周期**：
   - 头像仅允许使用系统内置书法印章或经过严格尺寸（<=200KB）与 MIME 校验的本地上传图片，彻底禁止外部 HTTP/HTTPS 链接，杜绝 SSRF 风险。
   - 支持用户自主导出个人档案（`/api/user/export`），导出文件不包含任何密码哈希或内部令牌。
   - 支持用户密码验证后自主注销账号，注销及清除历史对局时对局记录将被匿名化（对手结果保留，注销方匿名标记为“已注销玩家”）。

## 部署后验收检查清单

1. **健康检查**：访问 `/health`，应返回 `{"ok":true,"rooms":0,"users":8}`。
2. **多用户联机对弈**：
   - 用两个独立浏览器窗口分别访问游戏（一个注册玩家，一个游客身份）。
   - 玩家 1 创建房间，玩家 2 加入房间。
   - 双方准备后随机分配红黑方开局，走子与落子记录实时同步。
   - 刷新其中一方标签页，确认 30 秒内通过会话 Cookie 恢复连接。
3. **管理中心验证**：
   - 管理员账号进入 `/admin.html`，检查桌面（1280px）与移动端（375px）自适应排版。
   - 检查“账号与权限”、“对局档案”、“服务器设置”与新增的“操作审计日志”标签页。
   - 尝试修改角色或重置密码，验证密码再认证弹窗与审计日志生成。
4. **安全基线**：
   - 使用普通玩家账号或未携带凭据访问 `/api/admin/users`，验证服务端返回 403 / 401。
   - 验证浏览器控制台与网络请求中不包含明文密码，Cookie 正确包含 HttpOnly 标志。
