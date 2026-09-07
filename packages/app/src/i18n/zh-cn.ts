export const zhCN: Record<string, string> = {
  'tls.reset.warning':
    '此操作将直接删除全部本机 TLS 证书、私钥、ACME 账户及 DNS 凭据，无需解密旧材料。请先停止服务；之后须重新配置 HTTPS，新 CA 需要逐台更新成员的信任固定值。',
  'tls.reset.done': 'TLS 配置已清除。请启动服务，通过本地 HTTP 登录并重新配置 HTTPS。',
  'mesh.reset.warning': '此操作将清除所有通行密钥和 TOTP、撤销全部会话，并清空中继密封包。',
  'mesh.reset.confirm': '输入 yes 以继续',
  'mesh.reset.requiresYes': '非交互模式必须显式传入 --yes。',
  'mesh.reset.cancelled': '操作已取消。',
  'mesh.identity.warning':
    '此操作将更换本机节点身份、清除中继连接密钥与节点缓存，并撤销本机会话。保留账户凭据；完成后须重新加入 Hub 或中继。',
  'mesh.identity.done':
    '节点身份已重建：{{nodeId}}。请重新加入 Hub 或中继，然后重启服务；若 TLS 密钥也已丢失，请重新配置 HTTPS。',
  'mesh.keylog.fork':
    '检测到分叉。不要重放日志；执行 vibeterm mesh reset-root 后重新加入选定的可信链。',
  'mesh.keylog.unknown': '无法确认远端日志头；请启动或恢复本机网关的上行连接后重试。',

  'hub.urls.restartHint':
    '重启 VibeTerm 后种子地址生效。VIBETERM_HUB_URL 保持不变；全部成员迁移前应保留旧地址可访问。',
  'hub.trust.restartHint': '重启 VibeTerm，以新 CA 固定值重新连接。',
  'hub.ca.rotateWarning':
    '警告：CA 轮换将断开所有固定旧 CA 的节点，并清除停用的 ACME 账户及 DNS 凭据。继续前须确保可以在各成员上操作本机终端；轮换后须逐台执行 vibeterm hub trust refresh 并核对新指纹。',
  'hub.ca.rotateDone':
    'CA 已轮换。重启 Hub 后，在各成员上执行：vibeterm hub trust refresh <hubUrl> --fingerprint {{fingerprint}}，随后重启该成员。',

  'cli.error.unknownCommand': '未知命令：{{command}}',
  'cli.error.unknownFlag': '未知参数：--{{flag}}',

  'common.cancelled': '已取消。',
  'common.done': '完成。',

  'errors.args.missingFlag': '缺少必要参数：--{{flag}}',
  'errors.args.invalidFlag': '参数值非法：--{{flag}}={{value}}',

  'errors.validate.invalidPort': '非法端口：{{value}}',
  'errors.validate.emptyField': '{{field}} 不能为空。',

  'errors.version.invalid': '非法版本号：{{input}}',

  'errors.layout.packageRootNotFound': '无法定位 VibeTerm 包根目录，请确认 dist 产物完整。',
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
  'service.hint.launchd': 'launchctl print gui/$(id -u)/com.vibeterm.{{serviceName}}',
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
    '未检测到可用的服务管理器（平台：{{platform}}）。VibeTerm 需要 systemd（Linux）或 launchd（macOS）。',
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
  'doctor.tmux.fail': '未检测到 tmux（VibeTerm 需要 tmux >= 3.0 才能工作）。',
  'doctor.tmux.versionLow': 'tmux 版本过低：{{version}}（要求 >= 3.0）',
  'doctor.legacyLayout.leftovers':
    '发现改名前布局的残留文件，建议删除，避免旧版 CLI 拉起第二个实例。',
  'doctor.fix.header': '正在尝试修复问题...',
  'doctor.fix.skip': '跳过无法自动修复的项目：{{id}}',
  'doctor.fix.hint': '运行 "vibeterm doctor --fix" 尝试自动安装缺失的依赖。',
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
  'doctor.passkey.otherOrigin':
    '已有通行密钥，但 {{origin}} 上没有：该地址登录只有密码把关。登录后可为该地址添加；已有的通行密钥若无法使用，执行 vibeterm mesh passkey remove-all 全部移除。',
  'doctor.passkey.otherOriginTotp':
    '已有通行密钥，但 {{origin}} 上没有：该地址登录由密码与两步验证把关。登录后可为该地址添加；已有的通行密钥若无法使用，执行 vibeterm mesh passkey remove-all 全部移除。',

  'mesh.passkey.removed':
    '已移除 {{username}} 的 {{count}} 把通行密钥；两步验证与密码会话保持不变，用这些通行密钥建立的会话已注销。',

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
  'upgrade.assetMissing': '版本 {{version}} 的解压结果缺少 package/bin/vibeterm.js。',
  'upgrade.extractFailed': '解压发行包失败（退出码 {{code}}）。',
  'upgrade.lockHeld': '另有升级正在进行（pid {{pid}}）。若该进程已退出，请重试；锁文件：{{path}}。',
  'upgrade.legacyMissingVersion':
    'install-meta.json 缺少 cliVersion（{{path}}），无法转换旧版安装布局。',
  'upgrade.healthVersionMismatch': '健康检查版本不符：期望 {{expected}}，实际 {{actual}}。',
  'upgrade.integrityUnverified': '发行包缺少 SHA256SUMS，未校验完整性。',
  'upgrade.integrityMismatch': '发行包 sha256 与 SHA256SUMS 不符：{{file}}。',
  'upgrade.repairDone': '升级修复完成（{{action}}）。',
  'upgrade.rolledBack': '已回滚到 {{version}}：{{error}}',
  'upgrade.preflightFailed': '预启动 {{version}} 失败：{{error}}',
  'upgrade.serviceDidNotStop': '服务未在 {{timeout}}ms 内退出。',
  'upgrade.serviceStillRunning': '服务仍在运行',
  'upgrade.migrationStopFailed':
    '拒绝回退安装迁移：{{dir}} 的服务未停止（{{error}}）。请先停掉它，再执行 `vibeterm upgrade --repair`。',
  'upgrade.migrationRevertBlocked':
    '无法把安装搬回 {{dir}}：该路径已存在。请先移走或改名，再执行 `vibeterm upgrade --repair`。',
  'upgrade.healthStaleStartedAt': '健康检查 startedAt {{actual}} 不晚于本次重启时间 {{expected}}。',
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
  'upgrade.signatureRequired':
    '版本 {{version}} 缺少 SHA256SUMS.sig。{{since}} 起的发行包必须带签名，拒绝继续。',
  'upgrade.signatureInvalid': '版本 {{version}} 的 SHA256SUMS 签名无效（{{reason}}），拒绝继续。',
  'upgrade.signatureHttpFailed': '获取 SHA256SUMS.sig 失败：{{detail}}',
  'upgrade.pidNotOwned': 'PID {{pid}} 不属于此安装目录的 VibeTerm 运行时（{{installDir}}）。',
  'upgrade.healthTlsListenerDown': 'TLS 监听未运行（mode {{mode}}）。',

  'cli.shim.pathHint':
    '{{binDir}} 不在 PATH 中。加入后即可使用 vibeterm 命令：export PATH="{{binDir}}:$PATH"',
  'cli.shim.ready': 'CLI 命令：vibeterm（{{shimPath}}）',
  'cli.shim.skipOwned':
    '已跳过 PATH shim：现有安装 {{installDir}} 仍在使用；如需替换，请使用 init --replace-shim。',
  'cli.shim.skipUnknown':
    '已跳过 PATH shim：{{path}} 的安装归属未知；如需替换，请使用 init --replace-shim。',
  'cli.shim.skipForeign': '已跳过替换 {{path}}（现有文件不是 vibeterm 托管的 shim）。',

  'uninstall.prompt.removeService': '是否卸载系统服务',
  'uninstall.prompt.removeProgram': '是否删除程序文件（runtime/resources/cli/run.sh/meta）',
  'uninstall.prompt.removeEnv': '是否删除 app.env',
  'uninstall.prompt.removeDatabase': '是否删除数据库文件',
  'uninstall.done': '卸载完成。',
  'uninstall.summary.installDir': '安装目录',
  'uninstall.summary.serviceName': '服务名称',

  'tmux.notFound': '未检测到 tmux。VibeTerm 需要 tmux >= 3.0 才能工作。',
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
  'hub.join.admitPending': '已加入，等待已登录的浏览器批准',

  'hub.standby.missingPublicUrl': 'hub standby 需要 --public-url',
  'hub.standby.notJoined': '本机尚未加入 mesh（缺少 node_identity）。请先执行 vibeterm hub join。',
  'hub.standby.alreadyActive':
    '本机已是 active hub。请先执行 vibeterm hub demote，再设为 standby。',
  'hub.standby.missingHubUrl':
    '缺少 VIBETERM_HUB_URL（当前主 hub 地址）。standby 仍需以 node 身份连上主 hub。',
  'hub.standby.invalidPriority': '--priority 必须是 ≥ 0 的整数',
  'hub.standby.done': '已将本机设为 standby hub（priority={{priority}}，publicUrl={{url}}）',
  'hub.standby.nodeId': '本机 node id：{{nodeId}}',
  'hub.standby.allowHint':
    '当前 active hub 会忽略本机 standby，直到执行：vibeterm hub allow {{nodeId}}',
  'hub.standby.authorizedPrimary': '已授权当前主 hub {{nodeId}}；VIBETERM_HUB_PEERS={{peers}}',
  'hub.standby.noPrimary':
    '警告：找不到当前主 hub 可授权（mesh_hubs 无 active 行，peer_cache 也无 hub 哨兵）。请用 vibeterm hub allow 手动写入 VIBETERM_HUB_PEERS',
  'hub.peers.current': '当前 VIBETERM_HUB_PEERS={{peers}}',
  'hub.promote.notHub': 'hub promote 仅适用于 hub,node 安装',
  'hub.promote.needConfirm': '提升写者有脑裂风险。请加 --yes 确认，或在交互终端确认。',
  'hub.promote.warning':
    '警告：提升写者前必须先将原主 hub demote 或停机，否则会出现脑裂（split-brain）。',
  'hub.promote.emptyPeers':
    '警告：VIBETERM_HUB_PEERS 为空；本机未授权任何对端 hub（旧写者无法 fencing 本机）。请在原写者上执行：vibeterm hub allow {{nodeId}}',
  'hub.promote.allowReminder': '请在原写者上授权本机：vibeterm hub allow {{nodeId}}',
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

  'port.probe.searching': '地址未写端口，正在探测 443 及内置候选端口……',
  'port.probe.foundRelay': '已在 {{port}} 端口探测到中继，使用 {{url}}',
  'port.probe.foundHub': '已在 {{port}} 端口探测到 Hub，使用 {{url}}',
  'port.probe.notFound':
    '443 及内置候选端口（{{ports}}）均无响应，请放行端口或直接填写带端口的地址',
  'init.prompt.publicPort': '公网 HTTPS 端口（443 为标准端口，{{suggested}} 为建议的高位端口）',

  'relay.passwd.modeKick':
    '踢出模式：所有还在用旧口令的租户会被断开，需要重新执行 vibeterm relay reauth',
  'relay.passwd.modeKeep': '保留模式：已接入的租户继续在线，新口令只对新的接入生效',
  'relay.passwd.updated': '中继口令已更新（口令世代 {{epoch}}）',
  'relay.passwd.cleared': '已清除中继口令，接入不再需要口令（世代 {{epoch}}）',
  'relay.kick.offline': '中继成员：{{online}} 在线 / {{admitted}} 已接入。',
  'relay.kick.recovery':
    '先在可访问节点执行 vibeterm relay reauth <url>，再在离线成员上执行 vibeterm relay join <url> --tenant <id> --password。',
  'relay.kick.forceRequired': '存在离线成员，请使用 --force 确认操作。',
  'relay.kick.done': '已踢出租户 {{tenantId}}，其令牌在重新接入前失效',
  'relay.remove.confirm': '删除租户 {{tenantId}} 及其注册表与密钥日志？该操作不可撤销',
  'relay.remove.done': '已删除租户 {{tenantId}}',
  'relay.label.set': '已把租户 {{tenantId}} 的备注设为 {{label}}',
  'relay.label.cleared': '已清除租户 {{tenantId}} 的备注',
  'relay.quota.default': '默认配额：{{quota}}',
  'relay.quota.tenant': '租户 {{tenantId}} 配额：{{quota}}',
  'relay.limits.current': '中继限额：{{limits}}',
  'relay.limits.updated': '中继限额已更新：{{limits}}',
  'relay.enroll.passwordRequired': '该中继需要口令',
  'relay.enroll.readmitPending': '接入后仍有 {{count}} 个成员待重新确认，已中止 set-relays',
  'relay.enroll.done': '已接入中继 {{url}}（租户 {{tenantId}}）',
  'relay.enroll.pending': 'set-relays 已提交，但中继尚未挂上：{{url}} {{error}}',
  'relay.pack.tokenNotCurrent':
    '中继密封包上传需要当前令牌。请先在持有当前令牌的节点运行 vibeterm relay resend-token，或在本节点通过密码加入，再重试 vibeterm relay pack upload。',
  'relay.pack.materialMissing': '当前中继令牌或加密密钥不可用。',
  'relay.pack.failed': '中继密封包上传失败：{{reason}} 重试：{{command}}',
  'relay.pack.done': '已上传当前中继密封包。',
  'relay.resendToken.failed': '中继未确认 set-relays：{{reason}} 重试：vibeterm relay resend-token',
  'relay.resendToken.unconfirmed': '未收到确认。',
  'relay.resendToken.done': '已按当前令牌重新下发 set-relays，覆盖 {{count}} 个成员节点',
  'relay.leave.done': '已离开中继；在接入 hub 或中继前该节点没有上级',
  'relay.leave.pending': 'set-relays 已提交，但中继上行仍处于挂载状态',
};
