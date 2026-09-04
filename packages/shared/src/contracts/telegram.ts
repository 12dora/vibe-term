// Telegram 通知渠道契约

export interface TelegramBotConfig {
  id: string;
  name: string;
  enabled: boolean;
  allowAuthRequests: boolean;
  allowCommands: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramBotWithStats extends TelegramBotConfig {
  pendingCount: number;
  authorizedCount: number;
}

export type TelegramChatStatus = 'pending' | 'authorized';

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';

export interface TelegramBotChat {
  id: string;
  botId: string;
  chatId: string;
  chatType: TelegramChatType;
  displayName: string;
  userId: string | null;
  status: TelegramChatStatus;
  appliedAt: string;
  authorizedAt: string | null;
  updatedAt: string;
}

export interface ListTelegramBotsResponse {
  bots: TelegramBotWithStats[];
}

export interface ListTelegramBotChatsResponse {
  chats: TelegramBotChat[];
}
