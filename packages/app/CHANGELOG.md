# 2.12.0

_2026-10-13_

## English

### New

- File Manager: open a folder from the Files sidebar — "Open" next to a root folder, or "Open in File Manager" in any folder's menu — and browse it in the main area, Finder / Explorer style, with list and icon views, sorting, filtering, breadcrumbs and Back / Forward / Up.
- Tabs and split view with up to three panes. Drag tabs to reorder them or move them between panes.
- Select several items with click, Ctrl/⌘-click, Shift-click, drag-to-select or Select All, and work from the keyboard: arrow keys, Enter, Backspace, F2, Delete, cut / copy / paste and more. Press `?` in the File Manager to see every shortcut.
- Drag and drop to organise files: dragging within one device moves, dragging to another device or node copies (sent directly between nodes). Drop onto folders, breadcrumbs or tabs. Cut, copy and paste work across tabs.
- New Folder, Rename and Delete for files and folders, both in the File Manager and in the Files sidebar menus. Deleting always asks for confirmation.
- Download a folder, or several items at once, as a single `.tar.gz` archive. Upload whole folders by dropping them in.
- When an item with the same name already exists you are asked whether to replace or skip it — for moves, copies and uploads.

### Improvements

- Manage Devices now arranges nodes in a responsive grid: nodes with one device sit side by side, nodes with several devices take more columns. While dragging a node, the page shows exactly where it will land.
- Copying files between folders on the same machine now also works on installations that have not joined a relay.
- Large downloads that pass through another node no longer pile up in memory on the way.

### Fixes

- Fixed dragging a file from the Files sidebar to the desktop not starting in Chrome and Safari.

---

## 中文

### 新增

- 文件管理器：在侧栏「文件」中点击根目录右侧的「打开」，或在任意文件夹的菜单里选择「在文件管理器中打开」，即可在主区域像访达 / 资源管理器一样浏览，支持列表与图标视图、排序、筛选、面包屑，以及后退 / 前进 / 上一级。
- 标签页与分栏（最多三栏）。标签页可拖动排序，也可拖到其他分栏。
- 多选与键盘操作：单击、Ctrl/⌘ 点选、Shift 连选、框选、全选；方向键、Enter、Backspace、F2、Delete、剪切 / 复制 / 粘贴等。在文件管理器中按 `?` 查看全部快捷键。
- 拖拽整理文件：同一设备内拖拽为移动，拖到其他设备或节点为复制（节点之间直接传输）。可拖到文件夹、面包屑或标签页上。剪切、复制、粘贴可跨标签页使用。
- 文件与文件夹支持新建文件夹、重命名、删除，文件管理器与侧栏「文件」的菜单中均可使用。删除前会要求确认。
- 文件夹或多个项目可一次打包下载为一个 `.tar.gz`。把文件夹拖进来即可整个上传。
- 目标位置已有同名项目时会先询问替换还是跳过，移动、复制、上传均如此。

### 改进

- 「管理设备」改为自适应网格：只有一台设备的节点并排显示，有多台设备的节点占更多列。拖动节点时，页面会直接显示它松手后的位置。
- 未加入中继的单机安装也可以在本机的文件夹之间复制文件。
- 经其他节点中转的大文件下载不再在途中占用大量内存。

### 修复

- 修复在 Chrome 与 Safari 中无法把侧栏「文件」里的文件拖到桌面的问题。
