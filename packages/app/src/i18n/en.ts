export const en: Record<string, string> = {
  'tls.reset.warning':
    'This deletes all local TLS certificates, private keys, ACME account and DNS credentials without decrypting them. Stop the service first; HTTPS must be configured again and a new CA requires refreshing member trust pins.',
  'tls.reset.done':
    'TLS configuration cleared. Start the service, log in through local HTTP and configure HTTPS again.',
  'mesh.reset.warning':
    'This clears all passkeys and TOTP, revokes all sessions, and clears the relay pack.',
  'mesh.reset.confirm': 'Type yes to continue',
  'mesh.reset.requiresYes': 'Non-interactive use requires --yes.',
  'mesh.reset.cancelled': 'Operation cancelled.',
  'mesh.identity.warning':
    'This replaces the local node identity, clears relay keys and peer caches, and revokes local sessions. Account credentials are retained; re-join the hub or relay afterward.',
  'mesh.identity.done':
    'Node identity rebuilt: {{nodeId}}. Re-join the hub or relay, then restart the service. Reconfigure HTTPS if its private key was also lost.',
  'mesh.keylog.fork':
    'Fork detected. Do not replay records; run vibeterm mesh reset-root and re-join the chosen trusted chain.',
  'mesh.keylog.unknown':
    'Remote head unavailable; start or restore the local gateway uplink and retry.',

  'hub.urls.restartHint':
    'Restart VibeTerm to apply the seed URLs. VIBETERM_HUB_URL is unchanged; keep the old URL reachable until all members migrate.',
  'hub.trust.restartHint': 'Restart VibeTerm to reconnect with the new CA pin.',
  'hub.ca.rotateWarning':
    'WARNING: CA rotation disconnects every node pinned to the old CA and clears inactive ACME account and DNS credentials. Arrange local OS access to all members before continuing; each must run vibeterm hub trust refresh with the new fingerprint.',
  'hub.ca.rotateDone':
    'CA rotated. Restart the hub, then on each member run: vibeterm hub trust refresh <hubUrl> --fingerprint {{fingerprint}}. Restart each member afterwards.',

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
    'Unable to locate VibeTerm package root. Please ensure dist artifacts are complete.',
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
  'service.hint.launchd': 'launchctl print gui/$(id -u)/com.vibeterm.{{serviceName}}',
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
    'No supported service manager found (platform: {{platform}}). VibeTerm requires systemd (Linux) or launchd (macOS).',
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
  'doctor.tmux.fail': 'tmux not found (VibeTerm requires tmux >= 3.0).',
  'doctor.tmux.versionLow': 'tmux version too low: {{version}} (requires >= 3.0)',
  'doctor.legacyLayout.leftovers':
    'Leftover files from the pre-rename layout found. Remove them so an older CLI cannot start a second instance.',
  'doctor.fix.header': 'Attempting to fix issues...',
  'doctor.fix.skip': 'Skipping unfixable item: {{id}}',
  'doctor.fix.hint': 'Run "vibeterm doctor --fix" to attempt automatic installation.',
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
  'doctor.passkey.otherOrigin':
    'Passkeys exist, but none is registered for {{origin}}; signing in there is protected by the password alone. Add one after signing in, or run "vibeterm mesh passkey remove-all" if the existing passkeys are unusable.',
  'doctor.passkey.otherOriginTotp':
    'Passkeys exist, but none is registered for {{origin}}; signing in there is protected by the password and two-step verification. Add one after signing in, or run "vibeterm mesh passkey remove-all" if the existing passkeys are unusable.',

  'mesh.passkey.removed':
    'Removed {{count}} passkey(s) for {{username}}. Two-step verification and password sessions stay; sessions created with those passkeys are signed out.',

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
    'Extracted release is missing package/bin/vibeterm.js for version {{version}}.',
  'upgrade.extractFailed': 'Failed to extract the release tarball (exit {{code}}).',
  'upgrade.lockHeld':
    'Another upgrade is already running (pid {{pid}}). If that process is dead, retry; lock: {{path}}.',
  'upgrade.legacyMissingVersion':
    'install-meta.json is missing cliVersion ({{path}}). Cannot convert the legacy install layout.',
  'upgrade.healthVersionMismatch':
    'Health check version mismatch: expected {{expected}}, got {{actual}}.',
  'upgrade.integrityUnverified': 'Release SHA256SUMS is missing; tarball integrity is unverified.',
  'upgrade.integrityMismatch': 'Release tarball sha256 mismatch for {{file}}.',
  'upgrade.repairDone': 'Upgrade repair finished ({{action}}).',
  'upgrade.rolledBack': 'Upgrade rolled back to {{version}}: {{error}}',
  'upgrade.preflightFailed': 'Preflight of {{version}} failed: {{error}}',
  'upgrade.serviceDidNotStop': 'Service did not stop within {{timeout}}ms.',
  'upgrade.serviceStillRunning': 'the service is still running',
  'upgrade.migrationStopFailed':
    'Refusing to undo the install migration: the service in {{dir}} did not stop ({{error}}). Stop it, then run `vibeterm upgrade --repair`.',
  'upgrade.migrationRevertBlocked':
    'Cannot move the install back to {{dir}}: the path already exists. Remove or rename it, then run `vibeterm upgrade --repair`.',
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
  'upgrade.signatureRequired':
    'Release {{version}} has no SHA256SUMS.sig. Signed releases are required from {{since}} on; refusing to continue.',
  'upgrade.signatureInvalid':
    'Release {{version}} SHA256SUMS signature is not valid ({{reason}}). Refusing to continue.',
  'upgrade.signatureHttpFailed': 'Failed to fetch SHA256SUMS.sig: {{detail}}',
  'upgrade.pidNotOwned':
    'PID {{pid}} is not the VibeTerm runtime for this install ({{installDir}}).',
  'upgrade.healthTlsListenerDown': 'TLS listener is not running (mode {{mode}}).',

  'cli.shim.pathHint':
    '{{binDir}} is not on PATH. Add it so the vibeterm command is available: export PATH="{{binDir}}:$PATH"',
  'cli.shim.ready': 'CLI command: vibeterm ({{shimPath}})',
  'cli.shim.skipOwned':
    'Skipped PATH shims: existing install {{installDir}} owns them; use init --replace-shim to replace them.',
  'cli.shim.skipUnknown':
    'Skipped PATH shims: {{path}} has unknown install ownership; use init --replace-shim to replace it.',
  'cli.shim.skipForeign':
    'Skipped replacing {{path}} (existing file is not a vibeterm-managed shim).',

  'uninstall.prompt.removeService': 'Uninstall system service',
  'uninstall.prompt.removeProgram': 'Remove program files (runtime/resources/cli/run.sh/meta)',
  'uninstall.prompt.removeEnv': 'Remove app.env',
  'uninstall.prompt.removeDatabase': 'Remove database file',
  'uninstall.done': 'Uninstall completed.',
  'uninstall.summary.installDir': 'Install dir',
  'uninstall.summary.serviceName': 'Service name',

  'tmux.notFound': 'tmux not found. VibeTerm requires tmux >= 3.0 to operate.',
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
  'hub.join.admitPending': 'Joined; waiting for approval from a signed-in browser',

  'hub.standby.missingPublicUrl': 'hub standby requires --public-url',
  'hub.standby.notJoined':
    'this node is not joined (no node_identity); run vibeterm hub join first',
  'hub.standby.alreadyActive':
    'this install is already an active hub; run vibeterm hub demote first',
  'hub.standby.missingHubUrl':
    'VIBETERM_HUB_URL is empty; a standby hub still uplinks to the current primary',
  'hub.standby.invalidPriority': 'invalid --priority: must be a non-negative integer',
  'hub.standby.done': 'standby hub enabled (priority={{priority}}, publicUrl={{url}})',
  'hub.standby.nodeId': 'this node id: {{nodeId}}',
  'hub.standby.allowHint':
    'the active hub ignores this standby until it runs: vibeterm hub allow {{nodeId}}',
  'hub.standby.authorizedPrimary':
    'authorized current primary hub {{nodeId}}; VIBETERM_HUB_PEERS={{peers}}',
  'hub.standby.noPrimary':
    'WARNING: could not find the current primary hub to authorize (no active mesh_hubs row and no peer_cache hub sentinel); set VIBETERM_HUB_PEERS manually with vibeterm hub allow',
  'hub.peers.current': 'current VIBETERM_HUB_PEERS={{peers}}',
  'hub.promote.notHub': 'hub promote requires a hub,node install',
  'hub.promote.needConfirm':
    'promoting the writer risks split-brain; pass --yes or confirm interactively',
  'hub.promote.warning':
    'WARNING: demote or stop the previous writer before this node starts, or the mesh will split-brain.',
  'hub.promote.emptyPeers':
    'WARNING: VIBETERM_HUB_PEERS is empty; this hub authorizes no peers (the old writer cannot fence it). The previous writer must still run: vibeterm hub allow {{nodeId}}',
  'hub.promote.allowReminder':
    'the previous writer must authorize this hub with: vibeterm hub allow {{nodeId}}',
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

  'port.probe.searching': 'no port given; probing 443 and the built-in candidate ports…',
  'port.probe.foundRelay': 'relay found on port {{port}}; using {{url}}',
  'port.probe.foundHub': 'hub found on port {{port}}; using {{url}}',
  'port.probe.notFound':
    'no response on 443 or the built-in candidate ports ({{ports}}); open the port or give an address with an explicit port',
  'init.prompt.publicPort':
    'Public HTTPS port (443 = standard, {{suggested}} = suggested when the ISP blocks 443)',

  'relay.passwd.modeKick':
    'kick mode: every tenant using the old relay password is disconnected and must re-run vibeterm relay reauth',
  'relay.passwd.modeKeep':
    'keep mode: tenants already enrolled stay connected; the new password only applies to new enrollments',
  'relay.passwd.updated': 'relay password updated (password epoch {{epoch}})',
  'relay.passwd.cleared':
    'relay password cleared; enrollment no longer asks for one (epoch {{epoch}})',
  'relay.kick.offline': 'Relay members: {{online}} online / {{admitted}} admitted.',
  'relay.kick.recovery':
    'On a reachable node, run vibeterm relay reauth <url>; then offline members must run vibeterm relay join <url> --tenant <id> --password.',
  'relay.kick.forceRequired': 'Offline members require --force.',
  'relay.kick.done': 'tenant {{tenantId}} kicked; its token is void until it re-enrolls',
  'relay.remove.confirm':
    'Remove tenant {{tenantId}} together with its registry and key log? This cannot be undone',
  'relay.remove.done': 'tenant {{tenantId}} removed',
  'relay.label.set': 'tenant {{tenantId}} labelled {{label}}',
  'relay.label.cleared': 'tenant {{tenantId}} label cleared',
  'relay.quota.default': 'default quota: {{quota}}',
  'relay.quota.tenant': 'tenant {{tenantId}} quota: {{quota}}',
  'relay.limits.current': 'relay limits: {{limits}}',
  'relay.limits.updated': 'relay limits updated: {{limits}}',
  'relay.enroll.passwordRequired': 'this relay requires a password',
  'relay.enroll.readmitPending':
    'members still need re-affirming after enroll ({{count}}); aborting before set-relays',
  'relay.enroll.done': 'attached to relay {{url}} (tenant {{tenantId}})',
  'relay.enroll.pending':
    'set-relays was accepted but the relay is not attached yet: {{url}} {{error}}',
  'relay.pack.tokenNotCurrent':
    'Relay pack upload requires the current token. First run vibeterm relay resend-token on a node with the current token, or join with your password on this node; then retry vibeterm relay pack upload.',
  'relay.pack.materialMissing': 'Current relay token or encryption keys are unavailable.',
  'relay.pack.failed': 'Relay pack upload failed: {{reason}} Retry: {{command}}',
  'relay.pack.done': 'Current sealed relay packs uploaded.',
  'relay.resendToken.failed':
    'Relay did not acknowledge set-relays: {{reason}} Retry: vibeterm relay resend-token',
  'relay.resendToken.unconfirmed': 'Acknowledgment unavailable.',
  'relay.resendToken.done':
    'set-relays re-published with the current relay token for {{count}} member node(s)',
  'relay.leave.done': 'left the relay; this node has no upstream until you join a hub or a relay',
  'relay.leave.pending': 'set-relays was accepted but the relay uplink is still attached',
};
