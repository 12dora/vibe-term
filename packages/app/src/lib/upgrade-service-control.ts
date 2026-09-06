// 升级 / 修复期间的服务控制器：把「服务名 + 改名前的服务名 + 是否用旧 label」收敛成一处，
// 停服则等到进程真的退出、端口真的放开为止。
import { t } from '../i18n';
import type { InstallMeta, ServiceMode } from '../types';
import { createInstallLayout } from './install-layout';
import {
  getServiceStatus,
  installLegacyLabelledService,
  installService,
  stopService,
} from './service';
import type { ServiceDeps } from './service-types';
import {
  type ServiceReleaseProbes,
  type UpgradeServiceControl,
  createDirectProcessControl,
  pidFilePath,
  waitForServiceRelease,
  waitUntil,
} from './upgrade-process';

import { STOP_TIMEOUT_MS } from './upgrade-txn';

export function resolveServiceMode(meta: InstallMeta, noServiceFlag?: boolean): ServiceMode {
  if (meta.serviceMode === 'none' || meta.serviceMode === 'managed') return meta.serviceMode;
  return noServiceFlag ? 'none' : 'managed';
}

export function createManagedServiceControl(opts: {
  serviceName: string;
  installDir: string;
  autostart: boolean;
  runScriptPath: string;
  /** 改名前注册用的服务名；停止 / 安装时要连它留下的注册一起拆掉 */
  legacyServiceName?: string;
  /** 回滚安装迁移时用改名前的 launchd label 重新注册 */
  legacyLabel?: boolean;
  /** 测试注入：端口 / pid 探针，默认打真实 socket 与真实 pid 文件 */
  probes?: ServiceReleaseProbes;
  /** 测试注入：服务管理器与 launchctl / systemctl 执行器 */
  deps?: ServiceDeps;
}): UpgradeServiceControl {
  const identity = { legacyServiceName: opts.legacyServiceName, deps: opts.deps };
  const isRunning = async (): Promise<boolean> =>
    (await getServiceStatus(opts.serviceName, opts.installDir, identity)).running;

  return {
    async stop() {
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      await stopService(opts.serviceName, opts.installDir, identity);
      await waitUntil(
        async () => !(await isRunning()),
        STOP_TIMEOUT_MS,
        t('upgrade.serviceDidNotStop', { timeout: STOP_TIMEOUT_MS })
      );
      // 服务管理器报告「已停止」不等于进程已经退出：等 pid 死透、端口放开再交还控制权。
      await waitForServiceRelease({
        installDir: opts.installDir,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        probes: opts.probes,
      });
    },
    async start() {
      const install = opts.legacyLabel ? installLegacyLabelledService : installService;
      await install(
        {
          serviceName: opts.serviceName,
          runScriptPath: opts.runScriptPath,
          installDir: opts.installDir,
          autostart: opts.autostart,
          legacyServiceName: opts.legacyServiceName,
        },
        opts.deps
      );
    },
    isRunning,
  };
}

export function createServiceControl(opts: {
  installDir: string;
  meta: InstallMeta;
  noServiceFlag?: boolean;
  serviceName?: string;
  legacyServiceName?: string;
  legacyLabel?: boolean;
}): UpgradeServiceControl {
  const layout = createInstallLayout(opts.installDir);
  const mode = resolveServiceMode(opts.meta, opts.noServiceFlag);
  if (mode === 'none') {
    return createDirectProcessControl({
      runScriptPath: layout.runScriptPath,
      pidPath: pidFilePath(opts.installDir),
      installDir: opts.installDir,
    });
  }
  return createManagedServiceControl({
    serviceName: opts.serviceName ?? opts.meta.serviceName,
    legacyServiceName: opts.legacyServiceName,
    installDir: opts.installDir,
    autostart: opts.meta.autostart,
    runScriptPath: layout.runScriptPath,
    legacyLabel: opts.legacyLabel,
  });
}
