// 窗口内存限额（systemd pane scope）的网关设置端点。
// 记录是整条读写的：PUT 永远带全量五个字段，网关按 `WindowMemorySettings` 的口径校验。
//
// 失败一律抛 `ApiError`：经 `/n/<id>` 打远端节点时，转发器的顶层信封（503 `NODE_UNREACHABLE`、
// 401 `NODE_LOGIN_REQUIRED`）与老节点的 404/405 都要能被调用方区分出来，而不是折成一句兜底文案。

import { WINDOW_MEMORY_SETTINGS_DEFAULTS, type WindowMemorySettings } from '@vibeterm/shared';
import { type ApiClient, defaultApiClient, toApiError } from './client';
import { requestJson } from './json-mutation';

export const windowMemorySettingsQueryKey = ['window-memory-settings'] as const;

const WINDOW_MEMORY_SETTINGS_PATH = '/api/settings/window-memory';

type WindowMemorySettingsWire = Partial<WindowMemorySettings> & {
  settings?: Partial<WindowMemorySettings>;
};

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** 缺字段一律回落到契约默认值：旧网关可能还没有这条记录的全部字段。 */
function normalizeWindowMemorySettings(wire: WindowMemorySettingsWire): WindowMemorySettings {
  const record = wire.settings ?? wire;
  const defaults = WINDOW_MEMORY_SETTINGS_DEFAULTS;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : defaults.enabled,
    memoryHighMb: integerOr(record.memoryHighMb, defaults.memoryHighMb),
    memoryMaxMb: integerOr(record.memoryMaxMb, defaults.memoryMaxMb),
    memorySwapMaxMb: integerOr(record.memorySwapMaxMb, defaults.memorySwapMaxMb),
    sampleIntervalSec: integerOr(record.sampleIntervalSec, defaults.sampleIntervalSec),
  };
}

export async function getWindowMemorySettings(
  client: ApiClient = defaultApiClient
): Promise<WindowMemorySettings> {
  return requestJson<WindowMemorySettingsWire, WindowMemorySettings>(
    client,
    WINDOW_MEMORY_SETTINGS_PATH,
    {
      toError: (res) => toApiError(res, 'Failed to load window memory settings'),
      pick: normalizeWindowMemorySettings,
    }
  );
}

export async function putWindowMemorySettings(
  body: WindowMemorySettings,
  client: ApiClient = defaultApiClient
): Promise<WindowMemorySettings> {
  return requestJson<WindowMemorySettingsWire, WindowMemorySettings>(
    client,
    WINDOW_MEMORY_SETTINGS_PATH,
    {
      method: 'PUT',
      body,
      toError: (res) => toApiError(res, 'Failed to save window memory settings'),
      pick: normalizeWindowMemorySettings,
    }
  );
}

export type { WindowMemorySettings };
