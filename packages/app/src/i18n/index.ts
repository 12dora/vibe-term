import { cliHelpText } from '../cli/help';

export type CliLang = 'en' | 'zh-CN';

type Vars = Record<string, string | number | boolean | undefined>;

const MESSAGES: Record<CliLang, Record<string, string>> = {
  en: {
    'cli.error.unknownCommand': 'Unknown command: {{command}}',
    'cli.error.unknownFlag': 'Unknown flag: --{{flag}}',

    'common.cancelled': 'Cancelled by user.',
    'common.done': 'Done.',

    'errors.args.missingFlag': 'Missing required flag: --{{flag}}',
    'errors.args.invalidFlag': 'Invalid flag value: --{{flag}}={{value}}',

    'errors.validate.invalidPort': 'Invalid port: {{value}}',
    'errors.validate.emptyField': '{{field}} cannot be empty.',

    'errors.version.invalid': 'Invalid version: {{input}}',

    'errors.layout.packageRootNotFound':
      'Unable to locate tmex package root. Please ensure dist artifacts are complete.',
    'errors.layout.runtimeMissing': 'Runtime artifact not found: {{path}}',
    'errors.layout.feMissing': 'Frontend static assets not found: {{path}}',
    'errors.layout.drizzleMissing': 'Gateway migration assets not found: {{path}}',

    'bun.notFound': 'Bun not found. Please install Bun and ensure it is available in PATH.',
    'bun.versionExecFailed': 'Failed to execute bun --version. Please verify Bun installation.',
    'bun.versionTooLow': 'Bun version too low: current {{version}}, required >= {{minVersion}}',
    'bun.checkFailed': 'Bun check failed.',
    'bun.explicitInvalid': 'Specified bun path is invalid or not executable: {{path}}',
    'bun.unsafePath': 'Unsafe bun path (contains shell metacharacters): {{path}}',

    'service.install.unsupportedPlatform':
      'Automatic service installation is not supported on this platform: {{platform}}',
    'service.systemd.daemonReloadFailed': 'systemctl daemon-reload failed: {{detail}}',
    'service.systemd.enableFailed': 'systemctl enable failed: {{detail}}',
    'service.systemd.restartFailed': 'systemctl restart failed: {{detail}}',
    'service.launchd.bootstrapFailed': 'launchctl bootstrap failed: {{detail}}',
    'service.status.none': 'Service manager is not integrated for platform: {{platform}}',
    'service.status.plistMissing': 'launchd plist not found',
    'service.hint.systemd': 'systemctl --user status {{serviceName}}',
    'service.hint.launchd': 'launchctl print gui/$(id -u)/com.tmex.{{serviceName}}',
    'service.hint.none': 'No service manager command on this platform.',

    'init.prompt.installDir': 'Install directory (install-dir)',
    'init.prompt.host': 'Bind host',
    'init.prompt.port': 'Bind port',
    'init.prompt.dbPath': 'Database path (db-path)',
    'init.prompt.autostart': 'Enable autostart',
    'init.prompt.serviceName': 'Service name (service-name)',
    'init.prompt.dirExistsConfirm':
      'Directory {{installDir}} already exists. Continue (will not delete existing config/db)?',
    'init.error.installDirNotEmpty':
      'Install directory is not empty: {{installDir}}. Use --force to overwrite.',
    'init.error.noServiceManager':
      'No supported service manager found (platform: {{platform}}). tmex requires systemd (Linux) or launchd (macOS).',
    'init.warning.noServiceManager':
      'Service manager is not supported on platform {{platform}}. Files are deployed but autostart is not configured.',
    'init.done': 'Initialization completed.',
    'init.summary.installDir': 'Install dir',
    'init.summary.serviceName': 'Service name',
    'init.summary.bun': 'Bun',
    'init.summary.autostart': 'Autostart',
    'init.summary.autostart.on': 'on',
    'init.summary.autostart.off': 'off',
    'init.summary.serviceHint': 'Service status command',

    'doctor.platform.supported': 'Platform: {{platform}}',
    'doctor.platform.unsupported':
      'Platform {{platform}} is not officially supported (only macOS and common Linux distros are guaranteed).',
    'doctor.bun.ok': 'Bun installed: {{version}}',
    'doctor.bun.fail': 'Bun check failed: {{reason}}',
    'doctor.tmux.ok': 'tmux installed: {{version}}',
    'doctor.tmux.fail': 'tmux not found (tmex requires tmux >= 3.0).',
    'doctor.tmux.versionLow': 'tmux version too low: {{version}} (requires >= 3.0)',
    'doctor.fix.header': 'Attempting to fix issues...',
    'doctor.fix.skip': 'Skipping unfixable item: {{id}}',
    'doctor.fix.hint': 'Run "tmex doctor --fix" to attempt automatic installation.',
    'doctor.ssh.ok': 'ssh installed',
    'doctor.ssh.missing': 'ssh not found; SSH devices will not work.',
    'doctor.installDir.exists': 'Install directory exists: {{installDir}}',
    'doctor.installDir.missing': 'Install directory not found: {{installDir}}',
    'doctor.env.exists': 'Config file found: {{envPath}}',
    'doctor.env.missing': 'Config file not found: {{envPath}}',
    'doctor.env.keyMissing': 'Missing config key: {{key}}',
    'doctor.db.missing': 'Database file not found (may be normal before first start): {{path}}',
    'doctor.db.exists': 'Database file exists: {{path}}',
    'doctor.port.invalid': 'Invalid port in config: {{value}}',
    'doctor.service.notInstalled': 'Service not installed: {{serviceName}}',
    'doctor.service.notRunning': 'Service not running: {{serviceName}}',
    'doctor.service.running': 'Service running: {{serviceName}}',
    'doctor.service.noManager': '{{detail}}',
    'doctor.health.pass': 'Health check OK: {{url}}',
    'doctor.health.fail': 'Health check failed or unreachable: {{url}}',

    'upgrade.delegateFailed': 'Upgrade delegation failed with exit code {{code}}',
    'upgrade.missingMeta': 'Install metadata not found: {{path}}. Please run init first.',
    'upgrade.healthFailed': 'Health check failed: HTTP {{status}}',
    'upgrade.done': 'Upgrade completed.',
    'upgrade.failedRollingBack': 'Upgrade failed; rolling back.',
    'upgrade.summary.targetVersion': 'Target version',
    'upgrade.summary.installDir': 'Install dir',
    'upgrade.versionNotFound': 'Release not found: {{version}} (HTTP 404).',
    'upgrade.networkFailed': 'Failed to reach GitHub Releases: {{detail}}',
    'upgrade.latestLookupFailed': 'GitHub latest-release response is missing tag_name.',
    'upgrade.assetMissing':
      'Extracted release is missing package/bin/tmex.js for version {{version}}.',
    'upgrade.extractFailed': 'Failed to extract the release tarball (exit {{code}}).',
    'upgrade.lockHeld':
      'Another upgrade is already running (pid {{pid}}). If that process is dead, retry; lock: {{path}}.',
    'upgrade.legacyMissingVersion':
      'install-meta.json is missing cliVersion ({{path}}). Cannot convert the legacy install layout.',
    'upgrade.healthVersionMismatch':
      'Health check version mismatch: expected {{expected}}, got {{actual}}.',
    'upgrade.integrityUnverified':
      'Release SHA256SUMS is missing; tarball integrity is unverified.',
    'upgrade.integrityMismatch': 'Release tarball sha256 mismatch for {{file}}.',
    'upgrade.repairDone': 'Upgrade repair finished ({{action}}).',
    'upgrade.rolledBack': 'Upgrade rolled back to {{version}}: {{error}}',
    'upgrade.preflightFailed': 'Preflight of {{version}} failed: {{error}}',
    'upgrade.serviceDidNotStop': 'Service did not stop within {{timeout}}ms.',
    'upgrade.healthStaleStartedAt':
      'Health check startedAt {{actual}} is not newer than restart at {{expected}}.',
    'upgrade.nativeRequired':
      'Native Direct addon is installed on {{fromVersion}} but could not be installed into {{toVersion}}: {{error}}',
    'upgrade.noPidOwnership':
      'This install is not managed by a service (serviceMode=none) and has no live pid file. Stop the running process, then retry.',
    'upgrade.repairStartFailed': 'Repair could not start {{version}}: {{error}}',
    'upgrade.alreadyCurrent': 'Already running {{version}}; nothing to upgrade.',
    'upgrade.checksumHttpFailed': 'Failed to fetch SHA256SUMS: {{detail}}',
    'upgrade.integrityRequired':
      'Release {{version}} requires SHA256SUMS (HTTP 200, matching digest). Refusing to continue.',
    'upgrade.integrityUnverifiedDenied':
      'Release {{version}} has no SHA256SUMS. Re-run with --allow-unverified to proceed.',
    'upgrade.integrityMissingEntry': 'SHA256SUMS does not list {{file}}.',
    'upgrade.pidNotOwned': 'PID {{pid}} is not the tmex runtime for this install ({{installDir}}).',
    'upgrade.healthTlsListenerDown': 'TLS listener is not running (mode {{mode}}).',

    'cli.shim.pathHint':
      '{{binDir}} is not on PATH. Add it so the tmex command is available: export PATH="{{binDir}}:$PATH"',
    'cli.shim.ready': 'CLI command: tmex ({{shimPath}})',
    'cli.shim.skipForeign':
      'Skipped replacing {{path}} (existing file is not a tmex-managed shim).',

    'uninstall.prompt.removeService': 'Uninstall system service',
    'uninstall.prompt.removeProgram': 'Remove program files (runtime/resources/cli/run.sh/meta)',
    'uninstall.prompt.removeEnv': 'Remove app.env',
    'uninstall.prompt.removeDatabase': 'Remove database file',
    'uninstall.done': 'Uninstall completed.',
    'uninstall.summary.installDir': 'Install dir',
    'uninstall.summary.serviceName': 'Service name',

    'tmux.notFound': 'tmux not found. tmex requires tmux >= 3.0 to operate.',
    'tmux.versionTooLow': 'tmux version too low: current {{version}}, required >= 3.0',

    'deps.install.confirm': 'Install {{dep}} now?',
    'deps.install.running': 'Installing {{dep}}...',
    'deps.install.success': '{{dep}} installed successfully.',
    'deps.install.failed': 'Failed to install {{dep}}.',
    'deps.install.manual': 'Please install manually and retry.',
    'deps.install.sudoRequired': 'This operation requires sudo.',
    'deps.install.sudoUnavailable': 'sudo is not available. Please run as root or install sudo.',
    'deps.install.nonInteractive':
      'Missing dependency: {{dep}}. Use --install-deps to install automatically.',
    'deps.install.hint': 'Suggested install command: {{command}}',
    'deps.install.brewMissing': 'Homebrew not found. Install Homebrew first: https://brew.sh',
    'deps.install.unknownDistro':
      'Unable to detect Linux distribution. Please install {{dep}} manually.',

    'runtime.restartRequested': 'Restart requested; exiting for service manager restart.',
    'runtime.started': 'Service started on {{url}}',
    'runtime.frontendMissing': 'Frontend assets not found.',
    'runtime.methodNotAllowed': 'Method Not Allowed',
    'runtime.forbidden': 'Forbidden',
    'runtime.notFound': 'Not Found',

    'hub.join.replacedStale':
      'Replaced local account "{{username}}" from a previous hub; key log, passkeys, TOTP, sessions, and old node certs were wiped.',

    'hub.standby.missingPublicUrl': 'hub standby requires --public-url',
    'hub.standby.notJoined': 'this node is not joined (no node_identity); run tmex hub join first',
    'hub.standby.alreadyActive': 'this install is already an active hub; run tmex hub demote first',
    'hub.standby.missingHubUrl':
      'TMEX_HUB_URL is empty; a standby hub still uplinks to the current primary',
    'hub.standby.invalidPriority': 'invalid --priority: must be a non-negative integer',
    'hub.standby.done': 'standby hub enabled (priority={{priority}}, publicUrl={{url}})',
    'hub.standby.nodeId': 'this node id: {{nodeId}}',
    'hub.standby.allowHint':
      'the active hub ignores this standby until it runs: tmex hub allow {{nodeId}}',
    'hub.standby.authorizedPrimary':
      'authorized current primary hub {{nodeId}}; TMEX_HUB_PEERS={{peers}}',
    'hub.standby.noPrimary':
      'WARNING: could not find the current primary hub to authorize (no active mesh_hubs row and no peer_cache hub sentinel); set TMEX_HUB_PEERS manually with tmex hub allow',
    'hub.peers.current': 'current TMEX_HUB_PEERS={{peers}}',
    'hub.promote.notHub': 'hub promote requires a hub,node install',
    'hub.promote.needConfirm':
      'promoting the writer risks split-brain; pass --yes or confirm interactively',
    'hub.promote.warning':
      'WARNING: demote or stop the previous writer before this node starts, or the mesh will split-brain.',
    'hub.promote.emptyPeers':
      'WARNING: TMEX_HUB_PEERS is empty; this hub authorizes no peers (the old writer cannot fence it). The previous writer must still run: tmex hub allow {{nodeId}}',
    'hub.promote.allowReminder':
      'the previous writer must authorize this hub with: tmex hub allow {{nodeId}}',
    'hub.promote.done': 'promoted to active hub (writerEpoch={{epoch}})',
    'hub.demote.notHub': 'hub demote requires a hub,node install',
    'hub.demote.done': 'demoted to standby hub',
    'hub.allow.notHub': 'hub allow requires a hub,node install',
    'hub.allow.missingNodeId': 'hub allow requires <nodeId>',
    'hub.allow.invalidNodeId': 'invalid hub node id {{nodeId}}: must be 32 hex characters',
    'hub.allow.done': 'authorized hub peers: {{peers}}',
    'hub.disallow.notHub': 'hub disallow requires a hub,node install',
    'hub.disallow.missingNodeId': 'hub disallow requires <nodeId>',
    'hub.disallow.invalidNodeId': 'invalid hub node id {{nodeId}}: must be 32 hex characters',
    'hub.disallow.done': 'authorized hub peers: {{peers}}',
    'hub.peers.empty': '(none)',
    'hub.list.empty': 'mesh_hubs is empty (no hub set learned from node.list yet)',
    'hub.list.header':
      'NODE       NAME            MODE     PRI  EPOCH  AUTH  ONLINE  LAST SEEN             PUBLIC URL',

    'hub.user.passwd.hubTimeout':
      'Primary hub is unreachable; the change was not submitted. Switch hub roles, then retry.',
    'hub.user.passwd.hubNotWriter':
      'This hub is a standby and does not accept account changes. Switch hub roles, then retry.',
    'hub.user.passwd.nodesTooOld': 'Some nodes are older than 1.1.16. Update every node first.',
    'hub.user.passwd.failed': 'password update failed: {{error}}',
    'hub.user.passwd.doneKeep':
      'password updated for {{username}} (keep): existing sign-in methods remain',
    'hub.user.passwd.doneFullReset':
      'password updated for {{username}} (full-reset): passkeys, two-step verification, and sessions were removed',
  },
  'zh-CN': {
    'cli.error.unknownCommand': '未知命令：{{command}}',
    'cli.error.unknownFlag': '未知参数：--{{flag}}',

    'common.cancelled': '已取消。',
    'common.done': '完成。',

    'errors.args.missingFlag': '缺少必要参数：--{{flag}}',
    'errors.args.invalidFlag': '参数值非法：--{{flag}}={{value}}',

    'errors.validate.invalidPort': '非法端口：{{value}}',
    'errors.validate.emptyField': '{{field}} 不能为空。',

    'errors.version.invalid': '非法版本号：{{input}}',

    'errors.layout.packageRootNotFound': '无法定位 tmex 包根目录，请确认 dist 产物完整。',
    'errors.layout.runtimeMissing': '未找到 runtime 产物：{{path}}',
    'errors.layout.feMissing': '未找到前端静态资源：{{path}}',
    'errors.layout.drizzleMissing': '未找到网关迁移资源：{{path}}',

    'bun.notFound': '未检测到 Bun，请先安装 Bun 并确保在 PATH 中可用。',
    'bun.versionExecFailed': '无法执行 bun --version，请检查 Bun 安装是否完整。',
    'bun.versionTooLow': 'Bun 版本过低：当前 {{version}}，要求 >= {{minVersion}}',
    'bun.checkFailed': 'Bun 检查失败。',
    'bun.explicitInvalid': '指定的 bun 路径无效或不可执行：{{path}}',
    'bun.unsafePath': 'bun 路径包含 shell 特殊字符，不安全：{{path}}',

    'service.install.unsupportedPlatform': '当前平台不支持自动安装服务：{{platform}}',
    'service.systemd.daemonReloadFailed': 'systemctl daemon-reload 失败：{{detail}}',
    'service.systemd.enableFailed': 'systemctl enable 失败：{{detail}}',
    'service.systemd.restartFailed': 'systemctl restart 失败：{{detail}}',
    'service.launchd.bootstrapFailed': 'launchctl bootstrap 失败：{{detail}}',
    'service.status.none': '当前平台未集成服务管理：{{platform}}',
    'service.status.plistMissing': 'plist 不存在',
    'service.hint.systemd': 'systemctl --user status {{serviceName}}',
    'service.hint.launchd': 'launchctl print gui/$(id -u)/com.tmex.{{serviceName}}',
    'service.hint.none': '当前平台无服务管理命令',

    'init.prompt.installDir': '安装目录（install-dir）',
    'init.prompt.host': '监听 host',
    'init.prompt.port': '监听端口',
    'init.prompt.dbPath': '数据库路径（db-path）',
    'init.prompt.autostart': '是否启用开机启动',
    'init.prompt.serviceName': '服务名称（service-name）',
    'init.prompt.dirExistsConfirm':
      '目录 {{installDir}} 已存在，是否继续（不会删除现有配置与数据库）？',
    'init.error.installDirNotEmpty': '安装目录已存在且非空：{{installDir}}。如需覆盖请加 --force',
    'init.error.noServiceManager':
      '未检测到可用的服务管理器（平台：{{platform}}）。tmex 需要 systemd（Linux）或 launchd（macOS）。',
    'init.warning.noServiceManager': '当前平台 {{platform}} 未实现自动服务安装，已完成文件部署。',
    'init.done': '初始化完成。',
    'init.summary.installDir': '安装目录',
    'init.summary.serviceName': '服务名称',
    'init.summary.bun': 'Bun',
    'init.summary.autostart': '自启动',
    'init.summary.autostart.on': '开启',
    'init.summary.autostart.off': '关闭',
    'init.summary.serviceHint': '服务状态命令',

    'doctor.platform.supported': '平台：{{platform}}',
    'doctor.platform.unsupported':
      '当前平台 {{platform}} 非官方支持范围（仅保证 macOS 与常见 Linux 发行版）。',
    'doctor.bun.ok': 'Bun 已安装：{{version}}',
    'doctor.bun.fail': 'Bun 检查失败：{{reason}}',
    'doctor.tmux.ok': 'tmux 已安装：{{version}}',
    'doctor.tmux.fail': '未检测到 tmux（tmex 需要 tmux >= 3.0 才能工作）。',
    'doctor.tmux.versionLow': 'tmux 版本过低：{{version}}（要求 >= 3.0）',
    'doctor.fix.header': '正在尝试修复问题...',
    'doctor.fix.skip': '跳过无法自动修复的项目：{{id}}',
    'doctor.fix.hint': '运行 "tmex doctor --fix" 尝试自动安装缺失的依赖。',
    'doctor.ssh.ok': 'ssh 已安装',
    'doctor.ssh.missing': '未检测到 ssh，远程设备将不可用。',
    'doctor.installDir.exists': '安装目录存在：{{installDir}}',
    'doctor.installDir.missing': '未发现安装目录：{{installDir}}',
    'doctor.env.exists': '发现配置文件：{{envPath}}',
    'doctor.env.missing': '未发现配置文件：{{envPath}}',
    'doctor.env.keyMissing': '配置缺失：{{key}}',
    'doctor.db.missing': '数据库文件不存在（首次启动前可能正常）：{{path}}',
    'doctor.db.exists': '数据库文件存在：{{path}}',
    'doctor.port.invalid': '配置端口非法：{{value}}',
    'doctor.service.notInstalled': '服务未安装：{{serviceName}}',
    'doctor.service.notRunning': '服务未运行：{{serviceName}}',
    'doctor.service.running': '服务运行中：{{serviceName}}',
    'doctor.service.noManager': '{{detail}}',
    'doctor.health.pass': '健康检查通过：{{url}}',
    'doctor.health.fail': '健康检查失败或不可达：{{url}}',

    'upgrade.delegateFailed': '委托升级失败，退出码 {{code}}',
    'upgrade.missingMeta': '未找到安装元数据：{{path}}，请先执行 init',
    'upgrade.healthFailed': '健康检查失败：HTTP {{status}}',
    'upgrade.done': '升级完成。',
    'upgrade.failedRollingBack': '升级失败，开始回滚。',
    'upgrade.summary.targetVersion': '目标版本',
    'upgrade.summary.installDir': '安装目录',
    'upgrade.versionNotFound': '未找到版本 {{version}}（HTTP 404）。',
    'upgrade.networkFailed': '无法访问 GitHub Releases：{{detail}}',
    'upgrade.latestLookupFailed': 'GitHub latest-release 响应缺少 tag_name。',
    'upgrade.assetMissing': '版本 {{version}} 的解压结果缺少 package/bin/tmex.js。',
    'upgrade.extractFailed': '解压发行包失败（退出码 {{code}}）。',
    'upgrade.lockHeld':
      '另有升级正在进行（pid {{pid}}）。若该进程已退出，请重试；锁文件：{{path}}。',
    'upgrade.legacyMissingVersion':
      'install-meta.json 缺少 cliVersion（{{path}}），无法转换旧版安装布局。',
    'upgrade.healthVersionMismatch': '健康检查版本不符：期望 {{expected}}，实际 {{actual}}。',
    'upgrade.integrityUnverified': '发行包缺少 SHA256SUMS，未校验完整性。',
    'upgrade.integrityMismatch': '发行包 sha256 与 SHA256SUMS 不符：{{file}}。',
    'upgrade.repairDone': '升级修复完成（{{action}}）。',
    'upgrade.rolledBack': '已回滚到 {{version}}：{{error}}',
    'upgrade.preflightFailed': '预启动 {{version}} 失败：{{error}}',
    'upgrade.serviceDidNotStop': '服务未在 {{timeout}}ms 内退出。',
    'upgrade.healthStaleStartedAt':
      '健康检查 startedAt {{actual}} 不晚于本次重启时间 {{expected}}。',
    'upgrade.nativeRequired':
      '{{fromVersion}} 已安装 Direct 原生插件，但未能装入 {{toVersion}}：{{error}}',
    'upgrade.noPidOwnership':
      '本机安装未托管服务（serviceMode=none），且没有存活的 pid 文件。请先停止正在运行的进程，再重试。',
    'upgrade.repairStartFailed': '修复未能启动 {{version}}：{{error}}',
    'upgrade.alreadyCurrent': '当前已是 {{version}}，无需升级。',
    'upgrade.checksumHttpFailed': '获取 SHA256SUMS 失败：{{detail}}',
    'upgrade.integrityRequired':
      '版本 {{version}} 必须提供 SHA256SUMS（HTTP 200 且摘要匹配），拒绝继续。',
    'upgrade.integrityUnverifiedDenied':
      '版本 {{version}} 缺少 SHA256SUMS。若需跳过校验，请显式传入 --allow-unverified。',
    'upgrade.integrityMissingEntry': 'SHA256SUMS 中没有 {{file}}。',
    'upgrade.pidNotOwned': 'PID {{pid}} 不属于此安装目录的 tmex 运行时（{{installDir}}）。',
    'upgrade.healthTlsListenerDown': 'TLS 监听未运行（mode {{mode}}）。',

    'cli.shim.pathHint':
      '{{binDir}} 不在 PATH 中。加入后即可使用 tmex 命令：export PATH="{{binDir}}:$PATH"',
    'cli.shim.ready': 'CLI 命令：tmex（{{shimPath}}）',
    'cli.shim.skipForeign': '已跳过替换 {{path}}（现有文件不是 tmex 托管的 shim）。',

    'uninstall.prompt.removeService': '是否卸载系统服务',
    'uninstall.prompt.removeProgram': '是否删除程序文件（runtime/resources/cli/run.sh/meta）',
    'uninstall.prompt.removeEnv': '是否删除 app.env',
    'uninstall.prompt.removeDatabase': '是否删除数据库文件',
    'uninstall.done': '卸载完成。',
    'uninstall.summary.installDir': '安装目录',
    'uninstall.summary.serviceName': '服务名称',

    'tmux.notFound': '未检测到 tmux。tmex 需要 tmux >= 3.0 才能工作。',
    'tmux.versionTooLow': 'tmux 版本过低：当前 {{version}}，要求 >= 3.0',

    'deps.install.confirm': '是否现在安装 {{dep}}？',
    'deps.install.running': '正在安装 {{dep}}...',
    'deps.install.success': '{{dep}} 安装成功。',
    'deps.install.failed': '安装 {{dep}} 失败。',
    'deps.install.manual': '请手动安装后重试。',
    'deps.install.sudoRequired': '此操作需要 sudo 权限。',
    'deps.install.sudoUnavailable': 'sudo 不可用，请以 root 身份执行或安装 sudo。',
    'deps.install.nonInteractive': '缺少依赖：{{dep}}。使用 --install-deps 自动安装。',
    'deps.install.hint': '建议安装命令：{{command}}',
    'deps.install.brewMissing': '未检测到 Homebrew，请先安装 Homebrew：https://brew.sh',
    'deps.install.unknownDistro': '无法检测 Linux 发行版，请手动安装 {{dep}}。',

    'runtime.restartRequested': '收到重启请求，退出并等待服务管理器拉起。',
    'runtime.started': '服务已启动：{{url}}',
    'runtime.frontendMissing': '未找到前端静态资源。',
    'runtime.methodNotAllowed': '方法不允许',
    'runtime.forbidden': '禁止访问',
    'runtime.notFound': '资源不存在',

    'hub.join.replacedStale':
      '已替换本机账号「{{username}}」的旧 hub 状态；密钥日志、通行密钥、TOTP、会话与旧节点证书已清除。',

    'hub.standby.missingPublicUrl': 'hub standby 需要 --public-url',
    'hub.standby.notJoined': '本机尚未加入 mesh（缺少 node_identity）。请先执行 tmex hub join。',
    'hub.standby.alreadyActive': '本机已是 active hub。请先执行 tmex hub demote，再设为 standby。',
    'hub.standby.missingHubUrl':
      '缺少 TMEX_HUB_URL（当前主 hub 地址）。standby 仍需以 node 身份连上主 hub。',
    'hub.standby.invalidPriority': '--priority 必须是 ≥ 0 的整数',
    'hub.standby.done': '已将本机设为 standby hub（priority={{priority}}，publicUrl={{url}}）',
    'hub.standby.nodeId': '本机 node id：{{nodeId}}',
    'hub.standby.allowHint':
      '当前 active hub 会忽略本机 standby，直到执行：tmex hub allow {{nodeId}}',
    'hub.standby.authorizedPrimary': '已授权当前主 hub {{nodeId}}；TMEX_HUB_PEERS={{peers}}',
    'hub.standby.noPrimary':
      '警告：找不到当前主 hub 可授权（mesh_hubs 无 active 行，peer_cache 也无 hub 哨兵）。请用 tmex hub allow 手动写入 TMEX_HUB_PEERS',
    'hub.peers.current': '当前 TMEX_HUB_PEERS={{peers}}',
    'hub.promote.notHub': 'hub promote 仅适用于 hub,node 安装',
    'hub.promote.needConfirm': '提升写者有脑裂风险。请加 --yes 确认，或在交互终端确认。',
    'hub.promote.warning':
      '警告：提升写者前必须先将原主 hub demote 或停机，否则会出现脑裂（split-brain）。',
    'hub.promote.emptyPeers':
      '警告：TMEX_HUB_PEERS 为空；本机未授权任何对端 hub（旧写者无法 fencing 本机）。请在原写者上执行：tmex hub allow {{nodeId}}',
    'hub.promote.allowReminder': '请在原写者上授权本机：tmex hub allow {{nodeId}}',
    'hub.promote.done': '已提升为 active hub（writerEpoch={{epoch}}）',
    'hub.demote.notHub': 'hub demote 仅适用于 hub,node 安装',
    'hub.demote.done': '已降为 standby hub',
    'hub.allow.notHub': 'hub allow 仅适用于 hub,node 安装',
    'hub.allow.missingNodeId': 'hub allow 需要 <nodeId>',
    'hub.allow.invalidNodeId': '非法 hub node id {{nodeId}}：必须是 32 位十六进制',
    'hub.allow.done': '已授权 hub peers：{{peers}}',
    'hub.disallow.notHub': 'hub disallow 仅适用于 hub,node 安装',
    'hub.disallow.missingNodeId': 'hub disallow 需要 <nodeId>',
    'hub.disallow.invalidNodeId': '非法 hub node id {{nodeId}}：必须是 32 位十六进制',
    'hub.disallow.done': '已授权 hub peers：{{peers}}',
    'hub.peers.empty': '（空）',
    'hub.list.empty': '本地 mesh_hubs 为空（尚未从 node.list 学到其它 hub）',
    'hub.list.header':
      'NODE       NAME            MODE     PRI  EPOCH  AUTH  ONLINE  LAST SEEN             PUBLIC URL',

    'hub.user.passwd.hubTimeout': '主 Hub 不可达，修改未提交；请先切换 Hub 角色后重试。',
    'hub.user.passwd.hubNotWriter': '当前 Hub 为备用，不接受账号变更；请先切换 Hub 角色后重试。',
    'hub.user.passwd.nodesTooOld': '有节点版本低于 1.1.16，须先升级全部节点。',
    'hub.user.passwd.failed': '密码更新失败：{{error}}',
    'hub.user.passwd.doneKeep': '已更新 {{username}} 的密码（保留）：现有登录方式保持不变。',
    'hub.user.passwd.doneFullReset':
      '已更新 {{username}} 的密码（全量重置）：已移除通行密钥、两步验证并注销全部会话。',
  },
};

let currentLang: CliLang = 'en';

export function normalizeLang(input: string | undefined): CliLang {
  if (!input) return 'en';

  const raw = input.trim();
  if (!raw) return 'en';

  const lower = raw.toLowerCase();
  if (lower === 'en' || lower === 'en-us' || lower === 'en_us') return 'en';
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh_cn' || lower === 'cn') return 'zh-CN';

  return 'en';
}

export function setLang(lang: CliLang): void {
  currentLang = lang;
}

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
}

export function t(key: string, vars?: Vars): string {
  if (key === 'cli.help') {
    return cliHelpText(currentLang);
  }
  const table = MESSAGES[currentLang] ?? MESSAGES.en;
  const fallback = MESSAGES.en[key];
  const template = table[key] ?? fallback ?? key;
  return interpolate(template, vars);
}
