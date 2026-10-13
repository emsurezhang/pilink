# Cookbook：frp 公网链路连通性排查

> 真实案例沉淀（2026-10）：frpc 报 `dial tcp i/o timeout`，安全组已放行、frps 正常运行，最终定位为 **ECS 本机 ufw 默认 DROP**。
> 适用场景：PiLink 经 frp 暴露公网时的连接失败排查，同样适用于任意"安全组已放行但端口不通"的场景。

## 症状 → 结论速查

| 现象 | 结论 | 处理 |
|---|---|---|
| `lookup <IP>: no such host` | 配置问题：serverAddr 还是占位符 | 改配置后 `launchctl kickstart -k gui/$(id -u)/com.pilink.frpc` |
| `connection refused` | 端口可达但无进程监听 | 服务端进程没起/端口错了 |
| `i/o timeout` + **ping 通** | 包被静默丢弃：安全组 / 云防火墙 / **主机防火墙（ufw/iptables）** | 按本文阶梯排查 |
| `authorization failed` | token 不一致 | 对齐 frps/frpc 的 `auth.token` |
| TLS 握手错误 | `transport.tls.force`（frps）与 `transport.tls.enable`（frpc）不配对 | 见配置核对清单 |

## 排查阶梯（按顺序做，一步一定位）

### 第 1 步：确认"包是否离开本机、到达服务端"

```bash
# Mac（客户端）侧：连续测多个端口，判断是否"全部不通"
for p in 22 80 443 7000; do
  timeout 4 bash -c "echo > /dev/tcp/<ECS_IP>/$p" 2>/dev/null && echo "port $p: OPEN" || echo "port $p: 不通"
done

# ECS 侧：抓包，看 SYN 到没到（决定性二分）
tcpdump -i any port 7000 -nn
```

判读：
- **tcpdump 无输出** → 包死在云上层：安全组规则加错组/方向/协议、云防火墙策略、本地宽带出口问题（换手机热点试一次）
- **tcpdump 看到 `Flags [S]` 但无回包** → 包到主机但被内核丢弃：**100% 是主机防火墙**（见第 2 步）
- 有 `Flags [S.]`（SYN-ACK）→ 网络层正常，问题在应用层（token/TLS/服务本身）

### 第 2 步：检查主机防火墙（本案例的根因）

```bash
# Ubuntu 镜像几乎必中：ufw 开着 + INPUT policy DROP
iptables -L INPUT -n -v --line-numbers | head -5
# 若 policy 是 DROP 且链里有 ufw-* → ufw 在活动

ufw status numbered          # 看已放行列表
ufw allow 7000/tcp           # frp 控制端口
ufw allow 8443/tcp           # 公网 Nginx 业务端口
ufw allow 22/tcp             # 如需要 SSH（更安全：from <固定IP>）
```

`ufw allow` 即时生效。常见误区：*"我没装防火墙"* —— ufw 是 Ubuntu 预装的，"没配置过"不等于"没启用"。
验证是否被针对性拉黑：`iptables -L -n -v | grep <客户端公网IP>`（fail2ban 会在这里留 `f2b-*` 链）。

### 第 3 步：核对服务监听与安全组

```bash
ss -tlnp | grep 7000
# 必须 *:7000；若是 127.0.0.1:7000 说明 frps 绑错地址
```

安全组核对四要素：**入方向 / 允许 / TCP / 端口 `7000/7000` / 授权对象 `0.0.0.0/0`**，
且规则加在该 ECS **实际绑定**的安全组上（多实例多安全组时最易加错）。

## 修复后验证

```bash
# Mac 侧
nc -zv -w 3 <ECS_IP> 7000                  # succeeded!
tail -f ~/.pilink/frpc.log                 # [I] [login success] 即通
curl -I https://<ECS_IP>:8443              # 全链路（ECS Nginx 配好后）
```

frpc 默认每 5s 自动重连（`loginFailExit = false`），修复网络侧后**无需重启 frpc**。

## 本案例踩过的坑（配置类，防再犯）

1. **frpc 配置有两个副本**：launchd 服务读的是 `~/.pilink/frpc.toml`，改 `deploy/frp/frpc.toml` 不会生效。
   改完必须同步：`cp deploy/frp/frpc.toml ~/.pilink/frpc.toml && launchctl kickstart -k gui/$(id -u)/com.pilink.frpc`
2. **launchd 不展开 `~`**：plist 的 `ProgramArguments`/日志路径必须写绝对路径（`/Users/<user>/.pilink/...`）。
   Bootstrap 报 `Input/output error` 多半是因为服务**已加载过**，用 `launchctl print gui/$(id -u)/com.pilink.frpc` 确认状态。
3. **TLS 双层终结冲突**：frpc 的 `localPort` 应指向 **明文端口**（本机 Nginx `127.0.0.1:7787`），
   不能指 TLS 的 8443——公网 TLS 在 ECS Nginx 终结，隧道内（frp 自带 TLS）回环明文即可。
4. **ping 通 ≠ TCP 通**：ICMP echo 放行的环境（阿里云默认）会给人"网络正常"的错觉，
   排查以 TCP 层证据（nc/tcpdump）为准。

## 标准端口放行清单（ECS）

| 端口 | 用途 | 安全组 | ufw |
|---|---|---|---|
| 7000 | frp 控制连接（frpc 上行） | ✅ 入方向 TCP | ✅ `ufw allow 7000/tcp` |
| 8443 | 公网业务入口（ECS Nginx） | ✅ 入方向 TCP | ✅ `ufw allow 8443/tcp` |
| 22 | SSH（建议限定来源 IP） | ✅ 按需 | ✅ `ufw allow from <IP> to any port 22` |
| 17788 | frps 代理端口 | ❌ 绝不（`proxyBindAddr=127.0.0.1` 兜底） | ❌ |
| 80/443 | 仅 ACME 签发续期临时开放 | 临时 | 临时 |
