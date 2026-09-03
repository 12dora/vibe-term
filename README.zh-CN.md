<div align="right">
  <a href="./README.md">English</a>
</div>

<div align="center">
  <img src="apps/fe/public/logo.png" width="128" height="128" alt="tmex" />
</div>

<h1 align="center">tmex</h1>

<p align="center">
  为 AI Agent 时代重造的 tmux 终端工作区。<br/>
  让 Agent 长时运行、看屏告警、多设备管理，都能在任意终端完成。
</p>

<p align="center">
  <img src="docs/images/screenshot.png" width="640" alt="tmex 截图" />
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心亮点">核心亮点</a> ·
  <a href="#安装与升级">安装与升级</a> ·
  <a href="#安全">安全</a> ·
  <a href="#常见问题">常见问题</a>
</p>

---

## 快速开始

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash
```

安装脚本会自动生成密钥、部署运行文件、注册用户级服务（macOS 用 launchd，Linux 用 systemd）并启动 tmex。打开命令行输出的地址，添加设备即可开始使用。

## 核心亮点


| **AI 时代的开源方式** | **一键安装，自动升级** | **一个侧边栏管理全部** |
|---|---|---|
| tmex 在公开协作中持续迭代，每一次设计决策、方案取舍与踩坑记录都保留在 `prompt-archives/` 与 `docs/` 中，工程过程可查阅、可复现。 | 一键安装脚本自动安装并启动服务。升级可在设置页一键完成，或运行 `tmex upgrade`；失败时自动回滚到上一个可用版本。 | 左侧边栏整合设备树、AI Agent 与文件管理。Agent 与当前 tmux pane 绑定，切换 pane 时上下文自动跟随。 |

| **终端 Agent，不止写代码** | **Watch：后台值守哨兵** | **随时随地访问终端** |
|---|---|---|
| 服务端 AI Agent 可读屏、执行命令、向交互程序发按键、搜索网页与抓取页面。无论是写代码、查日志、重启服务、配置网络设备还是日常排障都能胜任。 | Watch 按规则持续看屏，下载卡住、构建报错、日志出现异常关键字时主动告警。通知通过 Telegram、Webhook 或浏览器推送发出。 | 电脑、平板、手机打开浏览器就能继续工作，安装为独立应用后体验更接近原生 App。手机输入专门打磨：虚拟键盘不打乱终端布局，编辑器模式让你从容编辑长命令。 |

| **Ghostty WASM 终端内核** | **本地与远程设备并排** | **原生 tmux Control Mode** |
|---|---|---|
| 浏览器端终端由 Ghostty 官方 VT 内核编译为 WebAssembly 提供，不依赖自研 ANSI 解析器，终端语义与原生客户端一致。 | 同一侧边栏管理本地机器与远程 SSH 主机，支持密码、私钥、SSH Agent、SSH Config 认证，设备树支持拖拽排序。 | 基于 tmux Control Mode 构建，pane 输出、窗口生命周期与 bell 通知实时到达。Web UI 可与 iTerm2 等原生 tmux 客户端共用同一份会话。 |

**多节点互联**：任意一台 tmex 都可以组网——一台有公网 HTTPS 地址的机器作为中继（Hub），其余机器用加入码加入，只需出站连接。每个节点都是完整入口：打开其中任意一台，就能看到并操作网内的全部机器。节点之间优先 WebRTC 直连，不通时回落 Hub 中转，链路端到端加密。在「设置 → 多节点互联」里配置，或用 `tmex init --role hub,node` 与 `tmex hub join <https-url> --token <t>`。

## 安装与升级

```bash
# 交互式安装（推荐）
curl -fsSL https://raw.githubusercontent.com/12dora/tmex-enhanced/main/install.sh | bash

# 无交互安装（适用于 CI 或自动化）
bash install.sh --no-interactive \
  --install-dir ~/.local/share/tmex \
  --host 127.0.0.1 \
  --port 9883 \
  --db-path ~/.local/share/tmex/data/tmex.db \
  --autostart true

# 环境诊断
tmex doctor

# 升级到最新版本
tmex upgrade

# 卸载
tmex uninstall
```

安装需要 [Bun](https://bun.sh)（安装脚本在缺失时会自动安装）。`doctor` 命令会检查环境并报告问题。若安装后找不到 `tmex` 命令，将 `~/.local/bin` 加入 PATH。

## 安全

tmex 内置完整的登录保护，但 standalone 安装默认**不启用**：全新安装绑定 `127.0.0.1:9883`，不提供登录页。在把界面暴露到本机以外之前，须先在「设置 → 远程访问」里开启登录保护。已组网的机器强制登录，没有这个开关。

**账号**：口令不离开浏览器。浏览器侧用 Argon2id（64 MiB、3 轮）从口令派生 Ed25519 根钥，服务端只存根公钥与 KDF 参数。登录签发有效期 18 小时的授权凭据给浏览器临时会话钥；节点会话按 18 小时滑动续期，绝对上限 7 天。登录失败按源 IP 与账号分别限流，凭证类失败一律返回同一个错误码。

**两种可选第二因素**：注册通行密钥（WebAuthn）后，口令登录须附带一次通行密钥断言；通行密钥也可以单独用于登录。源地址为回环、内网、链路本地或 CGNAT 的请求免这一步——`http://192.168.1.5:9883` 这类 IP 字面量地址无法注册 WebAuthn 凭证。两步验证（TOTP）与之独立，可同时启用；其密钥由根钥派生的密钥加密存放，仅在登录时现场解密。

**凭证轮换**：通行密钥、TOTP、节点证书与 Hub 授权都记录在一条由根钥签名的哈希链式密钥日志里，并同步到每个节点。常规改密只轮换根钥，通行密钥、TOTP 与已有会话保留；`tmex hub user passwd <user> --full-reset` 会同时移除全部通行密钥与 TOTP，并注销所有会话。

**多节点互联**：节点成员资格由根钥签发的 Ed25519 证书证明，Hub 不签发任何凭证。节点之间的链路双向认证，并以 AES-256-GCM 端到端加密，做中转的 Hub 只搬密文。

**传输**：内置 TLS 监听器可提供自签 CA 证书，或经 ACME（`http-01`，或通过 Cloudflare / DNSPod 的 `dns-01`）签发的 Let's Encrypt 证书；也可以在自己的反向代理上终止 TLS，并设 `TMEX_TRUST_PROXY=true`，让 tmex 读到真实的客户端地址与协议。没有公网 IP 时，tmex 自行下载并托管 `cloudflared`，用自有域名或临时隧道对外，并可在其前面强制校验 [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) 的 JWT。

- 密码与私钥均使用 AES-256-GCM 加密存储。
- Webhook 通知使用 HMAC-SHA256 签名验证。
- Agent 写终端操作默认按动作请求确认，且被绑定到单个 pane。
- `fetch_url` 默认拒绝回环、链路本地与私网地址，防止 SSRF。
- 每个节点都有「允许域名访问」开关：关闭后只有本机与局域网客户端能访问它，节点之间的服务流量不受影响。

**仍需自行处理**：口令须足够强；对外服务走 HTTPS（通行密钥与 `Secure` Cookie 依赖它）；保持所有节点为最新版本——滚动升级期间，版本落后的节点仍只校验口令。

## 常见问题

**Q：通知如何与 Coding Agent 配合？**

tmex 同时监听 BEL（`\a`）和常见的 OSC 通知序列（OSC 9、OSC 99、OSC 777 `notify`、iTerm2 OSC 1337 `RequestAttention`）。Claude Code、Codex、OpenCode 等主流 Coding Agent 已经内置其中一种通知方式，通常无需额外配置即可收到提醒。只有当你的 Agent 不发出任何通知序列时，才需要手动在提示词里要求它输出 `\a`。

**Q：Telegram 通知如何配置？**

在设置页添加一个或多个 Telegram Bot，然后审批允许接收告警的聊天。tmex 会在 bell 事件、Agent 确认请求、Watch 触发和出错时发送通知。每个 Bot 可服务多个聊天，你也可以随时撤销授权。

**Q：SSH 主机开启大量 pane 会不会耗尽 `MaxSessions`？**

不会。tmex 早期确实为每个 pane 开一条远程读取通道，现在一台设备的所有 pane 复用**同一条 tmux control-mode 通道**，另有一条常驻命令通道，以及一次性命令与文件传输用的短生命周期通道。通道数不再随 pane 数增长，OpenSSH 默认的 `MaxSessions=10` 通常够用。只有当你同时还在对同一主机跑 rsync 传输和自己的 SSH 会话时，才需要调高该值。

**Q：为什么 tmex 默认不开启 OSC passthrough？**

默认关闭 passthrough 可避免 pane 内程序将私有终端控制序列直接透传到宿主终端，从而缩小终端逃逸攻击面。如果你明确需要 iTerm2 等宿主终端接收 OSC 序列，可设置环境变量 `TMEX_TMUX_ALLOW_PASSTHROUGH=true`。

## License

MIT
