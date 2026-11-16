// doctor 的服务状态与「进程在、HTTP 卡死」提示；按 install-meta 记录的管理器给对应命令。
import { DEFAULT_SERVICE_NAME } from '../constants';
import { t } from '../i18n';
import { type ServiceManagerKind, detectServiceManager } from '../lib/platform';
import { getServiceStatus } from '../lib/service';
import { recordedManagerDeps } from '../lib/service-manager-meta';
import type { DoctorCheck, ServiceMode } from '../types';

function serviceCheck(
  level: DoctorCheck['level'],
  message: string,
  detail?: string
): DoctorCheck[] {
  return [{ id: 'service', level, message, detail }];
}

export async function checkService(input: {
  serviceName: string;
  installDir: string;
  serviceManager?: ServiceManagerKind;
  serviceMode?: ServiceMode;
}): Promise<DoctorCheck[]> {
  if (input.serviceMode === 'none') {
    return serviceCheck('pass', t('doctor.service.unmanaged'));
  }
  const status = await getServiceStatus(input.serviceName, input.installDir, {
    deps: recordedManagerDeps(input.serviceManager),
  });
  const { serviceName } = input;
  if (status.manager === 'none') {
    return serviceCheck('warn', t('doctor.service.noManager', { detail: status.detail || '' }));
  }
  if (!status.installed) {
    return serviceCheck('warn', t('doctor.service.notInstalled', { serviceName }), status.detail);
  }
  if (!status.running) {
    return serviceCheck('warn', t('doctor.service.notRunning', { serviceName }), status.detail);
  }
  return serviceCheck('pass', t('doctor.service.running', { serviceName }), status.detail);
}

export function loopStallCheck(input: {
  serviceRunning: boolean;
  timedOut: boolean;
  url: string;
  installDir: string;
  serviceManager?: ServiceManagerKind;
  serviceName?: string;
}): DoctorCheck[] {
  if (!input.serviceRunning || !input.timedOut) return [];
  const openrc = input.serviceManager === 'openrc';
  const key = openrc ? 'doctor.health.loopStallOpenrc' : 'doctor.health.loopStall';
  return [
    {
      id: 'loop-stall',
      level: 'fail',
      message: t(key, {
        url: input.url,
        installDir: input.installDir,
        serviceName: input.serviceName ?? DEFAULT_SERVICE_NAME,
      }),
    },
  ];
}

/** 只有确实卡死、且调用方没给出管理器时才现场探测。 */
export async function stallServiceManager(
  recorded: ServiceManagerKind | undefined,
  stalled: boolean,
  detect: () => Promise<ServiceManagerKind> = detectServiceManager
): Promise<ServiceManagerKind | undefined> {
  if (!stalled || recorded) return recorded;
  return await detect().catch(() => undefined);
}
