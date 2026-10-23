# 2.14.0

_2026-10-24_

## English

### New

- File preview: a back button returns to the folder in the File Manager, and Previous / Next buttons (or ← / → for images, PDFs, audio and video) step through the files in the same folder, in File Manager order. Browser Back also returns to the File Manager now.
- Files sidebar: switching to the Files tab opens the File Manager; a new button left of Refresh shows or hides it; every folder (not only roots) has Open / Close to show that folder in the File Manager.
- Uploads run several files at once and downloads fetch parts of a file in parallel. One progress card shows the overall progress plus a bar per file, based on real bytes sent and received.
- Node settings: new "Node connection proxy". Connections to nodes and relays go direct by default; choose "System proxy" to send them through HTTP_PROXY / HTTPS_PROXY. Local and private addresses always connect directly. Internet features (AI models, search, upgrades) keep using the system proxy as before. CLI: `vibeterm settings mesh proxy get|set`.

### Fixes

- Downloading a folder or several files from a remote node saved a file without an extension; it is now `name.tar.gz`.
- Downloads from remote nodes no longer fail when the connection switches between relay and direct mid-transfer: the transfer continues where it stopped.
- Failed transfers now say why (connection lost, sign-in required, node unreachable, size limit, file changed during transfer, …) instead of only "Download failed".
- Upload progress no longer jumps in 8 MB steps or sits at 50 %; finished cards no longer keep a Cancel button.
- Files with Chinese or other non-Latin names on SSH devices preview and download correctly; video seeking on files served by VibeTerm works.
- Browsing an SSH device no longer waits behind long-running downloads on the same device.

---

## 中文

### 新增

- 文件预览：新增「返回文件管理器」，回到文件所在目录；新增上一个 / 下一个（图片、PDF、音视频也可按 ← / →），按文件管理器的排序在同目录内切换。浏览器后退也能回到文件管理器。
- 文件侧栏：切到「文件」后右侧自动打开文件管理器；刷新按钮左侧新增展开 / 收起按钮；每个文件夹（不只是根目录）都可「打开 / 关闭」，在文件管理器中打开或关闭该目录。
- 上传多个文件时并发进行，下载时分段并行拉取；一张进度卡同时显示整体进度和每个文件的进度，按实际收发的字节计算。
- 节点设置新增「节点连接代理」：连接节点和中继默认直连，选「系统代理」则经 HTTP_PROXY / HTTPS_PROXY。本机与内网地址始终直连；大模型、搜索、升级等上网功能仍照常使用系统代理。命令行：`vibeterm settings mesh proxy get|set`。

### 修复

- 从远程节点下载文件夹或多个文件时，保存的文件没有扩展名；现在为 `名称.tar.gz`。
- 从远程节点下载时，链路在中继与直连之间切换不再导致下载失败，会从断点继续。
- 传输失败时显示具体原因（网络中断、需要登录该节点、节点不可达、超过大小上限、传输期间源文件变化等），不再只提示「下载失败」。
- 上传进度不再按 8 MB 跳变或卡在 50%；完成后的提示不再残留「取消」按钮。
- SSH 设备上中文等非拉丁字符命名的文件可正常预览和下载；由 VibeTerm 提供的视频可以拖动进度。
- 同一 SSH 设备有长时间下载时，浏览目录不再被阻塞。
