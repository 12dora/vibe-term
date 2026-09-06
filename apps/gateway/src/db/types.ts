import type { TelegramBotConfig, WeixinAccountConfig } from '@vibeterm/shared';

export interface DeviceTreeOrderRecord {
  deviceId: string;
  windows: string[];
  panes: Record<string, string[]>;
}

export interface TelegramBotConfigRecord extends TelegramBotConfig {
  tokenEnc: string;
  lastUpdateId: number | null;
}

export interface WeixinAccountConfigRecord extends WeixinAccountConfig {
  weixinUin: string | null;
  botTokenEnc: string | null;
  baseUrl: string | null;
  syncBuf: string | null;
}
