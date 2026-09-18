// 「内存限额」段上方的提示：有设备的宿主没有 pane scope（tmux < 3.6 / 没带 systemd 支持），
// 限额写得进设置，却落不到任何 cgroup 上。表单本身照常可用，这里只把「写了也不生效」说清楚。

import { type SessionsMemoryResponse, devicesWithoutMemoryLimits } from '@vibeterm/api-client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';

export type SessionsMemoryLoader = () => Promise<SessionsMemoryResponse>;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 拉一次 `GET /api/sessions/memory`，挑出「已连接且明确限不了」的设备名。
 * 拉取失败一律当作没有可提示的设备：这条提示是锦上添花，绝不能挡住限额表单。
 */
export function useMemoryLimitsUnsupported(load: SessionsMemoryLoader | undefined): string[] {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (!load) return;
    let alive = true;
    load()
      .then((response) => {
        if (alive) setNames(devicesWithoutMemoryLimits(response).map((row) => row.deviceName));
      })
      .catch(() => {
        if (alive) setNames([]);
      });
    return () => {
      alive = false;
    };
  }, [load]);

  return names;
}

/** 提示的两行：受影响的设备名 + 生效条件。 */
export function memoryLimitsUnsupportedLines(t: Translate, deviceNames: string[]): string[] {
  return [
    t('settings.nodes.memory.limitsUnsupported', { devices: deviceNames.join('、') }),
    t('settings.nodes.memory.limitsUnsupportedHint'),
  ];
}

export function MemoryLimitsUnsupportedNotice({ deviceNames }: { deviceNames: string[] }) {
  const { t } = useTranslation();
  if (deviceNames.length === 0) return null;
  const [devices, hint] = memoryLimitsUnsupportedLines(t, deviceNames);
  return (
    <Notice tone="warning" testId="memory-limits-unsupported">
      <p>{devices}</p>
      <p>{hint}</p>
    </Notice>
  );
}
