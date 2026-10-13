# ECS Nginx 部署手册（PiLink 公网入口）

> 目标：在 ECS 上部署 Nginx，作为 PiLink 的唯一公网入口（8443 TLS），经 frp 隧道回源到 Mac 上的 Gateway。
> 前置条件：frps 已在 ECS 运行（`:7000`），Mac 端 frpc 已登录成功且 `start proxy success`（见 `docs/cookbook-frp-连通性排查.md`）。

## 拓扑与文件

```
手机/公网 ──HTTPS──▶ ECS Nginx:8443 ──▶ 127.0.0.1:17788 (frps, 仅回环)
                        │                    │ TLS 隧道(:7000)
                        ▼                    ▼
                   本目录证书          Mac frpc ──▶ Mac Nginx:7787 ──▶ Gateway:7788
```

| 本目录文件 | 部署到 ECS 的位置 | 说明 |
|---|---|---|
| `pilink.conf` | `/etc/nginx/conf.d/pilink.conf` | 站点配置 |
| `pilink-ecs.pem` | `/etc/pilink/certs/pilink-ecs.pem` | 服务证书 + 私钥（SAN=`IP:101.200.193.92`，有效期 825 天） |
| `pilink-rootCA.pem` | 不上传 ECS（仅发放给手机/客户端） | CA 根证书，iOS 用 `.mobileconfig` 安装 |

> ⚠️ `*.pem/*.key` 已加入 `.gitignore`，**严禁提交**到任何仓库/聊天工具。泄露 `pilink-ecs.pem`（含私钥）等于泄露该 IP 的 HTTPS 身份，需重签。

## 部署步骤（Ubuntu）

```bash
# 1. 安装 Nginx
apt update && apt install -y nginx

# 2. 证书目录
mkdir -p /etc/pilink/certs

# 3. 上传两个文件（Mac 上执行；若 22 未对办公 IP 开放，见文末"无 SSH 时的替代"）
scp deploy/nginx/pilink-ecs.pem root@101.200.193.92:/etc/pilink/certs/
scp deploy/nginx/pilink.conf  root@101.200.193.92:/etc/nginx/conf.d/pilink.conf

# 4. 校验并加载
nginx -t && systemctl reload nginx

# 5. 主机防火墙放行（Ubuntu 镜像默认 ufw 启用 + INPUT DROP，极易遗漏！）
ufw allow 8443/tcp
ufw status numbered        # 确认 8443 在列表中
```

## 安全组（阿里云控制台）

ECS → 安全组 → 入方向手动添加：

| 规则 | 值 |
|---|---|
| 授权策略 / 方向 | 允许 / **入方向** |
| 协议 / 端口 | TCP / `8443/8443` |
| 授权对象 | `0.0.0.0/0` |

确认加在**该实例实际绑定**的安全组上。7000（frp）应已存在；**不要**放行 17788（frps `proxyBindAddr=127.0.0.1` 兜底）。

## 验证

```bash
# 任意外网机器（-k：公网证书是私有 CA 签发，命令行不携带信任链）
curl -k -I https://101.200.193.92:8443        # 期望 HTTP/2 200
curl -k -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     https://101.200.193.92:8443/ws            # 期望 101 Switching Protocols
```

手机访问 `https://101.200.193.92:8443`：已安装并完全信任 PiLink Local CA 的设备无警告；
新设备先安装 CA（iOS：Safari 打开 Mac 的 `https://<Mac>.local:8443/pilink-ca.mobileconfig`）。

## 日常使用

- **配对新设备**：Mac 执行 `curl -X POST http://127.0.0.1:7788/api/pair/create`，手机输入 8 位配对码
- **访问地址**：
  - 本机：`http://localhost:7788`
  - 局域网：`https://<Mac主机名>.local:8443`
  - 公网：`https://101.200.193.92:8443`

## 证书续期（825 天到期前）

在 **Mac** 上重签（CA 私钥在 `~/.pilink/certs/lan/rootCA.key`）：

```bash
cd ~/.pilink/certs/lan
# 修改 san-ecs.cnf 中的 IP（如 ECS IP 变更），然后：
openssl req -new -key pilink.key -out pilink-ecs.csr -subj "/CN=PiLink Public" -config san-ecs.cnf
openssl x509 -req -in pilink-ecs.csr -CA rootCA.pem -CAkey rootCA.key -CAcreateserial \
  -out pilink-ecs.crt -days 825 -sha256 -extensions ext -extfile san-ecs.cnf
cat pilink-ecs.crt pilink.key > pilink-ecs.pem
# 同步到仓库与 ECS
cp pilink-ecs.pem ~/Documents/Workspace/pi-link/deploy/nginx/
scp pilink-ecs.pem root@101.200.193.92:/etc/pilink/certs/
ssh root@101.200.193.92 'nginx -t && systemctl reload nginx'
```

## 故障排查

`docs/cookbook-frp-连通性排查.md`：症状速查表、`tcpdump` 二分定位法、ufw/安全组核对清单、配置类坑（frpc 双副本、launchd 路径、TLS 双层终结）。

## 附：无 SSH 通道时的文件上传替代

ECS 网页终端（VNC）中执行 `cat > <目标路径>`，Mac 侧 `cat <文件>` 复制内容粘贴，Ctrl+D 结束。
适用小文本；`pilink-ecs.pem`（约 3KB）亦可。建议顺手 `ufw allow from <办公IP> to any port 22` 以便后续维护。
