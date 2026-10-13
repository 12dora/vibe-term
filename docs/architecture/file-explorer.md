# 文件管理器：文件变更接口、工作区模型与拖拽语义

本文描述主区域的文件管理器（标签页、分栏、多选、拖拽移动 / 复制）以及支撑它的文件变更接口（删除、移动、重命名、打包下载）；面向改动 `apps/gateway/src/api/file-{delete,move,archive}.ts`、`packages/panels/src/explorer/`、`apps/fe/src/pages/explorer/` 的开发者。上传 / 下载协议见 [浏览器文件传输](./file-transfer.md)，跨节点复制用的传输任务见 [节点间文件传输](./node-to-node-transfer.md)。

## 背景与目标

文件侧栏只能预览、上传、下载。整理文件需要一个类访达 / 资源管理器的界面：在主区域浏览目录，支持多选与快捷键，在标签页、分栏之间拖拽移动或复制，并能新建文件夹、重命名、删除。

设计约束：

- 文件操作的安全边界仍是「文件根」：所有路径是 root 内的绝对路径，逐项返回结果，一项失败不影响其余项。
- 跨设备、跨节点的字节不经过浏览器：复用节点间传输任务。
- 文件管理器的代码不进首屏包。

## 文件变更接口

| 端点 | 作用 |
| --- | --- |
| `POST /api/files/delete` | `{ rootId, paths[] }`。目录递归删除，符号链接只删链接本身；根目录自身不可删 |
| `POST /api/files/move` | `{ rootId, paths[], destRootId?, destDir, onConflict? }`。同一设备内移动；源根与目标根不在同一设备时请求级 `invalid`（detail `cross_device`） |
| `POST /api/files/rename` | `{ rootId, path, name }`。原地改名，从不覆盖，同名已存在回 `already_exists` |
| `POST /api/files/archive/prepare` | `{ rootId, paths[] }`（须同属一个父目录）→ `{ archiveId, name }`，票据 5 分钟有效、绑定用户 |
| `GET /api/files/archive/:id` | 流式 `tar.gz`，无 `Content-Length`，浏览器原生接管下载 |

- 单次请求最多 `FILE_OP_MAX_PATHS`（500）条路径。`packages/api-client` 的 `deleteFiles` / `moveFiles` 按条数与请求体字节数自动分批，逐项结果按输入顺序拼回。
- 逐项结果 `{ path, ok, code? }`；请求级错误（根不存在、参数非法）走 `FileErrorCode` 对应的 HTTP 状态。新增错误码 `already_exists`（409）。
- `onConflict`：`fail`（缺省）逐项回 `already_exists`；`overwrite` 仅在源与目标都不是目录时替换。

### 边界校验

- 词法规范化后必须落在 root 内；本机设备再核对**父目录**的 `realpath` 仍在 root 的 `realpath` 之内，末段用 `lstat` 寻址、从不解引用。
- SSH 设备在同一次远端执行里做同样的核对：`cd` 到父目录后取物理路径比对。物理路径用 `remote-script.ts` 的 `phys` 取得——`$(pwd -P)` 会吃掉结尾换行，目录名以换行结尾时会比对到另一个路径。
- 打包下载在**下载时**按当前根重新校验票据里的每个路径：票据签发后根目录配置变更，旧票据即失效。

### 远端脚本的执行方式

`apps/gateway/src/files/remote-script.ts`：脚本经 stdin 交给 `ssh … sh -s`，不放进 argv。

- 登录 shell 不必是 POSIX shell（fish / csh）。
- 批量操作的脚本带几百个文件名，不会撞上内核的单参数长度上限。
- 脚本内每条会读 stdin 的命令都重定向 `</dev/null`，避免吃掉后续脚本。
- 脚本开头固定 `LC_ALL=C`，错误输出只用于状态分类。

### 移动的落位规则

本机（`move-local.ts`）：

- 默认不覆盖。普通文件用 `link` + `unlink` 提交（`link` 对已存在的目标原子失败），目录用 `mkdir` 占位后 `rename`。符号链接、不支持硬链接的文件系统退回「检查后 rename」——Node / Bun 没有 `renameat2(RENAME_NOREPLACE)`，这一窗口只对并发的外部写入方有意义。
- 跨文件系统（`EXDEV`）：先复制到目标目录内的私有临时项，再按同样的规则提交，最后删除源。失败只清理临时项。
- 提交后删除源失败：保留目标并报告失败，不做破坏性回滚；重试时识别「不同父目录下的同 inode」补删源完成。同一父目录下的同 inode 可能是大小写别名，按普通改名处理。

远端（`move-remote.ts`）遵循一条原则：**不让 `mv` 复制数据，不凭错误输出决定破坏性步骤，目标条目提交之后才删源。** `mv` 的跨设备回退（复制 + 删除）在 GNU / BusyBox / FreeBSD / macOS 上顺序与报错各不相同，无法控制。

- 普通文件：先用硬链接（跨挂载点或不支持硬链接时改为显式 `cp -a`）在目标目录内得到私有临时项 `.vtmv.<pid>.<序号>`，再同目录改名提交（同目录改名不会跨设备），最后删除源。提交前任何失败都只清理这份私有临时项，源始终完好。
- 覆盖：目标是普通文件时同目录改名原子替换；目标是符号链接时先把旧链接改名到私有备份，提交失败即恢复，成功后才删除备份。
- 目录：先用一个空探测文件试硬链接，判断能否直接改名；能则 `mv -n`，不能则显式 `cp -a` 到私有临时项后改名提交，再删源。目录从不覆盖已有目标。
- 同 inode：源与目标在不同父目录时是两个硬链接（上一次提交后删源失败的残留），补删源即完成；在同一父目录时可能是不区分大小写 / 规范化的卷上的同一目录项，按普通改名处理，绝不删除。
- 同 inode 的判断按**父目录身份**（远端 `-ef`，本机 `dev`+`ino`）而不是路径字符串：经绑定挂载别名访问同一目录时两条路径是同一目录项，只在源父目录内改名，绝不删除。
- 显式复制用 `cp -a`：扩展属性、ACL 的保留程度与目标平台自带 `mv` 跨文件系统时一致（GNU / macOS 尽力保留，BusyBox / FreeBSD 不保留通用扩展属性，目标文件系统不支持时静默丢弃）。
- 删源失败：目标保留并报告失败，数据同时存在于两处，不做破坏性回滚。
- 残余窗口：没有原子 no-replace 改名的平台上，最后一次检查与改名之间存在并发写入窗口；shell 在复制途中被杀时，目标目录会留下 `.vtmv.*`；少数文件系统（如 overlayfs 的目录改名）仍可能触发 `mv` 的隐式复制，失败时留下不完整的目标，只报告、不清理。

### 打包下载

- 本机：`tar -czf - -C <父目录> ./名称…`；SSH：远端脚本核对边界后在已核对的工作目录里 `exec tar`。名称一律以 `./` 开头，不会被当成选项。
- 两个计时器：等待上游输出时用空闲超时（120 秒）；等待下游取数时用停滞超时（15 分钟）。慢速但持续接收的客户端不会被误杀。
- 客户端取消、tar 非零退出、超出总字节上限都会终止进程并清理；节点间转发的响应体按需拉取（`mesh/stream-http-response.ts`），入口节点不堆积。

## 前端结构

| 位置 | 内容 |
| --- | --- |
| `packages/stores/src/explorer-workspace*.ts` | 工作区模型：标签页、分栏（最多 3 栏）、导航历史、剪贴板。状态迁移为纯函数，持久化数据读回时校验修复 |
| `packages/stores/src/explorer.ts` | 值入口 `@vibeterm/stores/explorer`。**不从包主入口导出**：主入口被应用入口 chunk 静态引用，从那里导出会把模型带进首屏 |
| `packages/panels/src/explorer/` | 单个标签页的浏览器：`model/`（选择、排序、拖拽载荷、快捷键表，纯逻辑）、`views/`（列表 / 图标视图、框选、行内编辑）、`chrome/`（工具栏、面包屑、状态栏）、`actions/`（上传、下载、右键菜单） |
| `packages/panels/src/files/ops/` | 侧栏与文件管理器共用的新建 / 重命名 / 删除 |
| `apps/fe/src/pages/explorer/` | 工作区宿主：分栏与分隔线、标签栏、节点运行时挂载、跨标签传输 |

- 工作区是跨节点共享的一个整体，路由只有 `/explorer`（带节点前缀的写法在登录门闸之前折回）。每个标签页自带节点，内容区套该节点的运行时。
- 目录列表与侧栏共用同一个查询 key（`['files','list', rootId, path]`），两边自动同步。
- 侧栏根目录行尾的「打开 / 关闭」对应工作区里是否存在该根的标签页。

## 拖拽与剪贴板语义

- 同一设备内拖拽 = 移动；跨设备或跨节点 = 复制；按住 Alt / Ctrl 在同设备内强制复制。
- 移动走 `POST /api/files/move`；复制走传输任务（先在目标节点换 grant，再在源节点建任务）。未组网的单机安装同样可用：同节点任务不依赖 mesh 桥接。
- 目标已有同名项时先询问：替换 / 跳过 / 取消。上传同理；无法确认是否同名的项目按冲突处理，「跳过」只上传确定不存在的文件。
- 剪贴板记的是路径。条目被重命名、移动、删除后，引用该路径（或其后代）的剪贴板整份作废，避免粘贴到日后在同一路径新建的文件。
- 拖拽源依赖原生 HTML5 拖拽。全局样式对所有元素设了 `-webkit-user-drag: none`，只对 `draggable="true"` 放行（`apps/fe/src/index.css`）。

## 快捷键

定义在 `packages/panels/src/explorer/model/shortcuts.ts`，界面内按 `?` 查看。不绑定浏览器保留的组合（Ctrl+T / W / N、F5、Ctrl+R）；涉及 Alt 的组合按 `event.code` 匹配。焦点在输入框、可激活控件或对话框内时不触发。

## 测试

- 网关：`apps/gateway/src/api/file-{delete,move,rename,archive}*.test.ts`、`apps/gateway/src/files/{move-*,delete-remote,archive-stream,remote-script}.test.ts`。远端脚本用本机 `sh -s` 真实执行。
- 前端纯逻辑：`packages/stores/src/explorer-workspace-*.test.ts`、`packages/panels/src/explorer/**/**.test.ts`。
- 端到端：`apps/fe/tests/explorer.spec.ts`（打开、导航、多选、键盘、文件操作、分栏间拖拽、剪切粘贴、打包下载、上传同名询问）。

## 注意 / 限制

- Bun 1.4 的 `realpathSync` 认不出名称含反斜杠的路径，这类文件在本机设备上会被报 `not_found`。
- 文件夹下载为 `tar.gz`，不支持断点续传；单次打包最多 500 个顶层项目。
- 目录列表每目录上限 2000 项，被截断时全选只作用于已加载的项目。
