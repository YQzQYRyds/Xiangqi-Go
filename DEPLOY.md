# 弈界联机版部署

本项目已提供网页、联机服务器和 Docker 配置。无需数据库、构建步骤或第三方 npm 运行依赖。使用一个服务进程即可管理最多 5 间双人房。

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

默认映射宿主机 `5173` 端口。更改 `compose.yaml` 中端口映射左侧可换对外端口，例如 `8080:5173`。镜像内以非 root 用户运行，并自带 `/health` 健康检查。

更新代码后再次执行 `docker compose up -d --build`。更新会重启服务，当前房间和对局会清空，建议在无人对局时更新。

## 域名与 HTTPS 反向代理

可以在服务前使用 Nginx。下列配置演示反向代理部分；将 `game.example.com` 换成实际域名，并根据自己的证书配置 HTTPS。若 Nginx 与游戏都在 Docker 中，应将上游改为对应容器服务地址。

```nginx
server {
    listen 80;
    server_name game.example.com;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 75s;
    }
}
```

联机使用 **HTTP POST + SSE 长连接**，不是 WebSocket。必须关闭代理缓冲，让事件及时到达；服务器每 10 秒发送一次心跳。不要把 `/api/` 放入 CDN 缓存。

公网部署建议启用 HTTPS，以保护浏览器与服务器之间的玩家会话令牌。`PUBLIC_ORIGIN=https://你的域名` 可显式配置浏览器来源；代理也应保留原始 Host。前端使用同源相对地址，不需要修改域名或硬编码服务器 IP。

## 部署后验收

1. 访问 `/health`，应返回 `{"ok":true,"rooms":0}`（已有房间时数量相应变化）。
2. 用两个不同浏览器或独立隐私窗口打开游戏。
3. 第一个玩家创建房间，第二个玩家进入同一房间。
4. 两人分别准备，核对随机分配的红黑身份。红方先行，两边棋谱与棋盘应同步。
5. 刷新其中一个标签页，应在 30 秒内自动恢复身份与棋局。
6. 退出后，最后一人离开时房间应消失。

## 运行范围

- 最多 5 间房，每间 2 人；目前不提供观战、账号系统、跨设备恢复或匹配排名。
- 房间、会话与棋局存在服务器内存中。重启清空。仅部署 **一个实例、一个 Node 进程**；不要设置 PM2 cluster 或多个容器副本。
- 断线宽限约 30 秒，服务端每秒清理一次。主动退出立即离房；游戏中离房判负。无人房间自动销毁。
- 刷新恢复依赖原标签页的 sessionStorage；关闭标签页后重新打开不保证恢复原身份。
- 服务端限制房间容量、校验走法、拒绝过期局面与重复操作，并限制请求速率。`server.js`、`lobby.js`、测试文件等服务端文件不作为静态资源公开。
- 本地 PVE/PVP 入口为大厅右上方“本地练习”；联机房间内须先退出才能切换本地模式。
