/** 常驻运行时（server.ts 启动链）用到的英文文案；CLI 全量表 en.ts 在此基础上展开。 */
export const enRuntime: Record<string, string> = {
  'errors.validate.invalidPort': 'Invalid port: {{value}}',
  'errors.validate.emptyField': '{{field}} cannot be empty.',

  'errors.layout.packageRootNotFound':
    'Unable to locate VibeTerm package root. Please ensure dist artifacts are complete.',
  'errors.layout.runtimeMissing': 'Runtime artifact not found: {{path}}',
  'errors.layout.feMissing': 'Frontend static assets not found: {{path}}',
  'errors.layout.drizzleMissing': 'Gateway migration assets not found: {{path}}',

  'service.install.unsupportedPlatform':
    'Automatic service installation is not supported on this platform: {{platform}}',
  'service.systemd.daemonReloadFailed': 'systemctl daemon-reload failed: {{detail}}',
  'service.systemd.enableFailed': 'systemctl enable failed: {{detail}}',
  'service.systemd.restartFailed': 'systemctl restart failed: {{detail}}',
  'service.systemd.lingerEnabled':
    'Enabled systemd linger for {{user}} so the service keeps running after logout (opt out with --no-linger).',
  'service.systemd.lingerFailed':
    'Could not enable systemd linger; the service stops when your last login session ends. Run: {{command}}',
  'service.launchd.bootstrapFailed': 'launchctl bootstrap failed: {{detail}}',
  'service.status.none': 'Service manager is not integrated for platform: {{platform}}',
  'service.status.plistMissing': 'launchd plist not found',
  'service.hint.systemd': 'systemctl --user status {{serviceName}}',
  'service.hint.launchd': 'launchctl print gui/$(id -u)/com.vibeterm.{{serviceName}}',
  'service.hint.none': 'No service manager command on this platform.',
  'service.hint.openrc': 'rc-service {{serviceName}} status',
  'service.status.openrcNotBooted':
    'OpenRC is installed but did not boot this system (common in containers); services cannot be managed.',
  'service.openrc.sudoPrompt':
    'The OpenRC service is managed as root; sudo may ask for your password.',
  'service.openrc.sudoRequired':
    'Root access is required for "{{command}}". Run as root or with sudo, or pass --no-service.',
  'service.openrc.commandFailed': '{{command}} failed: {{detail}}',
  'service.openrc.unsafePath':
    'Path not allowed for an OpenRC service (use only letters, digits and _ . / : @ + -): {{path}}',
  'service.openrc.foreignScript':
    '{{path}} was not written by VibeTerm; choose another name with --service-name.',
  'service.openrc.ownedByOther':
    '{{path}} belongs to the VibeTerm install at {{installDir}}; use --service-name or --force.',
  'service.openrc.refreshSkipped':
    'OpenRC service files not refreshed (needs sudo); starting the existing service: {{detail}}',
  'service.openrc.invalidName': 'Invalid OpenRC service or user name: {{name}}',
  'service.openrc.sudoersSkipped':
    'Could not install the sudoers rule; upgrades and restarts from the web UI will need sudo: {{detail}}',
  'service.openrc.uninstallManual':
    'Could not remove the OpenRC service ({{detail}}). Run as root: {{commands}}',

  'runtime.restartRequested': 'Restart requested; exiting for service manager restart.',
  'runtime.started': 'Service started on {{url}}',
  'runtime.frontendMissing': 'Frontend assets not found.',
  'runtime.methodNotAllowed': 'Method Not Allowed',
  'runtime.forbidden': 'Forbidden',
  'runtime.notFound': 'Not Found',
};
