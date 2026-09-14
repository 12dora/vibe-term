<div align="right">
  <a href="./docs/README.en.md">English</a>
</div>

<div align="center">
  <img src="apps/fe/public/logo.png" width="112" height="112" alt="VibeTerm" />
</div>

<h1 align="center">VibeTerm - 做最好用的远程 Vibe Coding 终端</h1>

<p align="center">
  <a href="https://github.com/12dora/vibe-term/releases"><img src="https://img.shields.io/github/v/release/12dora/vibe-term?label=release" alt="Release" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-000" alt="Bun" />
</p>

<p align="center">
  开源、自托管的 Web 远程终端：在手机、平板或任意浏览器里，管理所有设备的终端。<br/>
  让 Claude Code、Codex、Grok 等 AI 编码助手远程集中管理，后台运行，实现随时随地看结果、发指令。
</p>

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
```

<p align="center">
  <img src="docs/images/hero.png" width="880" alt="VibeTerm 主界面：浏览器中的 tmux 终端正在运行 Claude Code，左侧是多台设备的设备树" /><br/>
  <sub>桌面端：左侧为跨设备的设备列表，右侧为终端界面 Claude Code</sub>
</p>

VibeTerm 将 Mac、Linux 服务器、NAS 和云主机组网。所有接入节点只需联网，支持无公网 IP 下 NAT 穿透。比 SSH 客户端与云端 IDE 更好用的远程开发方式：终端始终运行在用户自己的设备上，切换设备、关闭浏览器任务不中断。

## 特色功能

<table width="100%">
  <tr><th width="33%">多机互联</th><th width="33%">十分安全</th><th width="33%">终端共享</th></tr>
  <tr><td valign="top">登录任意一台，即可远程操作全部设备。</td><td valign="top">E2EE 加密，中转服务器只见密文。节点间互不信任，任意节点被攻破，其他节点依旧安全无虞。</td><td valign="top">像网盘一样，一条链接把终端分享给同事，支持口令保护与录制回放。</td></tr>
  <tr><th width="33%">如本地般流畅</th><th width="33%">文件传输</th><th width="33%">AI Agent</th></tr>
  <tr><td valign="top">滚动、输入与本地终端一样跟手，手机滑动丝般流畅。</td><td valign="top">浏览器与任意节点之间，文件自由互传。</td><td valign="top">由 AI 接管终端，无需在每个设备安装 AI 助手。</td></tr>
  <tr><th width="33%">端口映射</th><th width="33%">手机与平板</th><th width="33%">通行密钥</th></tr>
  <tr><td valign="top">把远端的端口映射到本机，通过 localhost:端口 访问远程服务。</td><td valign="top">PWA 应用支持，近原生体验。</td><td valign="top">支持通行密钥 / 验证器两步验证，安全更进一步。</td></tr>
</table>

## 平台支持

<table width="100%">
  <tr><th width="25%"><img width="250" height="0" align="left" />macOS</th><th width="25%"><img width="250" height="0" align="left" />Linux</th><th width="25%"><img width="250" height="0" align="left" />Windows</th><th width="25%"><img width="250" height="0" align="left" />iOS / Android</th></tr>
  <tr><td align="center">✅</td><td align="center">✅</td><td align="center">开发中</td><td align="center">✅ 通过 PWA 应用支持</td></tr>
</table>

<table width="100%">
  <tr>
    <td width="33%" align="center" valign="top"><img width="330" height="0" align="left" /><img src="docs/images/mobile.png" width="240" alt="VibeTerm 手机端：远程 tmux 终端" /><br/><sub>终端：Claude Code 界面，底部为快捷键</sub></td>
    <td width="33%" align="center" valign="top"><img width="330" height="0" align="left" /><img src="docs/images/mobile-devices.png" width="240" alt="VibeTerm 手机端：设备与窗口抽屉" /><br/><sub>设备：显示全部节点窗口列表</sub></td>
    <td width="33%" align="center" valign="top"><img width="330" height="0" align="left" /><img src="docs/images/mobile-files.png" width="240" alt="VibeTerm 手机端：文件面板" /><br/><sub>文件：浏览、上传与下载远端文件</sub></td>
  </tr>
</table>

## 部署模式

<table width="100%">
  <tr><th width="50%">独立</th><th width="50%">中继模式</th></tr>
  <tr><td valign="top">单机安装即用，默认只监听本机。</td><td valign="top">无公网地址时，借用他人或自建的中继转发密文，多人可共用一台中继。中继只见密文，节点之间也可直连。登录入口在租户自己的任意一台节点上。</td></tr>
</table>

<p align="center">
  <img src="docs/images/nodes.png" width="880" alt="VibeTerm 节点管理：多台设备组成 mesh，显示在线状态与直连方式" /><br/>
  <sub>设置 → 多节点互联：HTTPS 方式与节点管理，两台设备在线</sub>
</p>

## 部署方式

### AI 部署

将下面的提示词发给 Claude Code、Codex 等 AI 编码助手，助手会读取 [AI 部署指南](./docs/operations/ai-deploy.md) 并在目标设备上完成部署。尖括号里的内容按实际情况替换。

| 场景 | 提示词 |
|---|---|
| 独立部署 | `请读取 https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md，按「独立部署」一节在这台设备上部署 VibeTerm。` |
| 建立中继 · 有公网域名 | `请读取 https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md，按「中继：公网域名」一节部署中继。域名是 <域名>，80/443 端口 <可用/不可用>。` |
| 建立中继 · 无公网 IP，路由器端口转发 | `请读取 https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md，按「中继：端口转发」一节部署中继。路由器会把公网端口 <端口> 转发到这台设备，公网地址是 <IP 或 DDNS 域名>。` |
| 建立中继 · 无公网 IP，Cloudflare Tunnel | `请读取 https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md，按「中继：Cloudflare Tunnel」一节部署中继。隧道域名是 <域名>。` |
| 加入中继 | `请读取 https://raw.githubusercontent.com/12dora/vibe-term/main/docs/operations/ai-deploy.md，按「加入中继」一节把这台设备接入中继。中继地址是 <地址>，租户编号是 <编号>。` |

### 人工部署

一行命令安装后，用 `vibeterm --help` 查看全部子命令；`vibeterm doctor` 诊断环境，`vibeterm upgrade` 升级。完整手册见 [部署指南](./docs/operations/production-install.md) 与 [mesh 运维](./docs/operations/mesh-operations.md)。

## 命令行

安装包自带 `vibeterm` 客户端命令：在终端里做网页端能做的事——像 ssh 一样接进任意节点的终端窗格、传文件、映射端口、管理节点与站点设置。它只经 HTTP / WebSocket 访问入口，因此也可以装在没有部署 VibeTerm 服务的机器上；跑在一台机器上的 AI 编码助手用它就能调试 mesh 里的其它设备。

```bash
vibeterm login --entry https://vt.example.com --user admin      # 一次登录，覆盖入口后面的全部节点
vibeterm nodes ls                                               # 节点清单与在线状态
vibeterm term attach konata-mac/dev                             # 接进某台设备的终端窗格
vibeterm term run konata-mac/dev "make test" --marker --json    # 非交互跑一条命令，拿输出与退出码
vibeterm term capture konata-mac/dev --strip-ansi               # 抓当前画面
vibeterm cp ./dist air:home/dist -r                             # 本机与节点之间传文件
vibeterm port map 8080 air:127.0.0.1:8080                       # 把远端端口映射到 localhost:8080
vibeterm api GET /api/mesh/nodes --json                         # 没包成命令的接口直接打
vibeterm logout                                                 # 撤销会话
```

**安全边界与网页端完全一致。** CLI 没有任何「本机特权」：它拿的是和浏览器一样的会话 cookie，访问别的节点同样走入口的 `/n/<节点>/` 转发并带那个节点自己的会话，从不使用本机的 mesh 身份或主密钥。会话随时可撤销，`vibeterm logout` 等同于网页端退出登录。开了两步验证时，交一次有效的 TOTP 验证码即可（通行密钥同样满足，但只能在浏览器里做）；非交互场景把密码放 `VIBETERM_PASSWORD`、验证码放 `VIBETERM_TOTP`，不要写进命令行参数。

完整用法见[命令行使用手册](./docs/operations/cli-usage.md)。

## 致谢

VibeTerm 基于 [krhougs/tmex](https://github.com/krhougs/tmex) 二次开发，没有原作者的基础，本项目便无从谈起。

## 文档

架构、运维、安全与开发文档见 [docs/](./docs/README.md)。

## 开源协议

[MIT](./LICENSE)
