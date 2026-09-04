import { Bot } from 'gramio';
import { decryptWithContext } from '../crypto';
import {
  createOrUpdatePendingTelegramChat,
  getAllTelegramBots,
  getSiteSettings,
  listAuthorizedTelegramChatsByBot,
  updateTelegramBot,
} from '../db';
import { t } from '../i18n';
import { createTelegramAdapter, processInboundCommand } from '../messaging';

function normalizeChatType(
  raw: string | undefined
): 'private' | 'group' | 'supergroup' | 'channel' | 'unknown' {
  if (!raw) return 'unknown';
  if (raw === 'private' || raw === 'group' || raw === 'supergroup' || raw === 'channel') {
    return raw;
  }
  return 'unknown';
}

function buildChatDisplayName(params: {
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  fallback: string;
}): string {
  if (params.title?.trim()) {
    return params.title.trim();
  }
  if (params.username?.trim()) {
    return `@${params.username.trim()}`;
  }
  const fullName = `${params.firstName ?? ''} ${params.lastName ?? ''}`.trim();
  if (fullName) {
    return fullName;
  }
  return params.fallback;
}

interface RunningBot {
  id: string;
  token: string;
  bot: Bot;
  // 与 gramio Updates 内部 offset 对齐：getUpdates 末条 update_id+1，无更新则保持原值
  pollOffset: number;
}

export class TelegramService {
  private runningBots = new Map<string, RunningBot>();

  async sendGatewayOnlineMessage(siteName: string): Promise<void> {
    const settings = getSiteSettings();
    const text = t('telegram.gatewayOnline', {
      siteName,
    });

    await this.sendToAuthorizedChats({ text });
  }

  async refresh(): Promise<void> {
    const botConfigs = getAllTelegramBots();
    const activeIds = new Set(botConfigs.map((bot) => bot.id));

    const toStop: string[] = [];
    for (const [botId] of this.runningBots) {
      if (!activeIds.has(botId)) {
        toStop.push(botId);
      }
    }
    await Promise.all(toStop.map((botId) => this.stopBot(botId)));

    for (const config of botConfigs) {
      if (!config.enabled) {
        await this.stopBot(config.id);
        continue;
      }

      const token = await decryptWithContext(config.tokenEnc, {
        scope: 'telegram_bot',
        entityId: config.id,
        field: 'token_enc',
      });
      const running = this.runningBots.get(config.id);
      if (running && running.token === token) {
        continue;
      }

      if (running) {
        await this.stopBot(config.id);
      }

      const bot = new Bot(token);

      bot.on('message', async (context) => {
        const chat = context.chat;
        const from = context.from;
        await this.handleIncomingText({
          botId: config.id,
          text: context.text?.trim() ?? '',
          chatId: String(chat.id),
          chatType: chat.type,
          fromId: from?.id == null ? null : String(from.id),
          title: chat.title,
          username: chat.username,
          firstName: from?.firstName,
          lastName: from?.lastName,
          reply: async (body, parseMode) => {
            await context.send(body, parseMode ? { parse_mode: parseMode } : undefined);
          },
        });
      });

      bot.onError((error) => {
        console.error(`[telegram] bot ${config.id} runtime error:`, error);
      });

      const started: RunningBot = {
        id: config.id,
        token,
        bot,
        pollOffset: 0,
      };
      bot.onResponse('getUpdates', (context) => {
        const lastUpdateId = context.response.at(-1)?.update_id;
        if (typeof lastUpdateId === 'number') {
          started.pollOffset = lastUpdateId + 1;
        }
      });

      await bot.start({
        longPolling: {
          timeout: 30,
        },
      });

      this.runningBots.set(config.id, started);
      updateTelegramBot(config.id, { lastUpdateId: started.pollOffset });

      console.log(`[telegram] bot started: ${config.name} (${config.id})`);
    }
  }

  async handleIncomingText(params: {
    botId: string;
    text: string;
    chatId: string;
    chatType: string | undefined;
    fromId: string | null;
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    reply: (text: string, parseMode?: 'HTML') => Promise<void>;
  }): Promise<void> {
    if (params.text === '/start') {
      await this.handleStart(params);
      return;
    }
    if (!params.text) return;
    const outcome = await processInboundCommand({
      rawText: params.text,
      actor: {
        platform: 'telegram',
        accountId: params.botId,
        conversationId: params.chatId,
        userId: params.fromId,
      },
      adapter: createTelegramAdapter(),
    });
    if (outcome.silent) return;
    for (const chunk of outcome.chunks) {
      try {
        await params.reply(chunk, 'HTML');
      } catch (err) {
        console.error(
          `[telegram] failed sending command reply bot=${params.botId} chat=${params.chatId}:`,
          err
        );
      }
    }
  }

  private async handleStart(params: {
    botId: string;
    chatId: string;
    chatType: string | undefined;
    fromId: string | null;
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    reply: (text: string, parseMode?: 'HTML') => Promise<void>;
  }): Promise<void> {
    const latest = getAllTelegramBots().find((item) => item.id === params.botId);
    if (!latest || !latest.allowAuthRequests) {
      return;
    }

    const displayName = buildChatDisplayName({
      title: params.title,
      username: params.username,
      firstName: params.firstName,
      lastName: params.lastName,
      fallback: params.chatId,
    });

    try {
      const result = createOrUpdatePendingTelegramChat({
        botId: params.botId,
        chatId: params.chatId,
        chatType: normalizeChatType(params.chatType),
        displayName,
        appliedAt: new Date().toISOString(),
        userId: params.fromId,
      });

      if (result.status === 'authorized') {
        await params.reply(t('telegram.authSuccess'));
      } else {
        await params.reply(t('telegram.authPending'));
      }
    } catch (err) {
      await params.reply(t('telegram.authFailed'));
      console.error('[telegram] failed to save pending chat:', err);
    }
  }

  async sendToAuthorizedChats(params: {
    text: string;
    parseMode?: 'HTML' | 'MarkdownV2';
  }): Promise<void> {
    for (const [botId, running] of this.runningBots) {
      const chats = listAuthorizedTelegramChatsByBot(botId);
      if (chats.length === 0) {
        continue;
      }

      await Promise.all(
        chats.map(async (chat) => {
          try {
            await running.bot.api.sendMessage({
              chat_id: chat.chatId,
              text: params.text,
              ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
            });
          } catch (err) {
            console.error(
              `[telegram] failed sending message to bot=${botId} chat=${chat.chatId}:`,
              err
            );
          }
        })
      );
    }
  }

  async sendTestMessage(botId: string, chatId: string, text: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      throw new Error(t('telegram.botNotRunning'));
    }

    await running.bot.api.sendMessage({
      chat_id: chatId,
      text,
    });
  }

  async stopAll(): Promise<void> {
    const botIds = Array.from(this.runningBots.keys());
    await Promise.all(botIds.map((botId) => this.stopBot(botId)));
  }

  async syncBotOffset(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      return;
    }

    updateTelegramBot(botId, { lastUpdateId: running.pollOffset });
  }

  private async stopBot(botId: string): Promise<void> {
    const running = this.runningBots.get(botId);
    if (!running) {
      return;
    }

    await this.syncBotOffset(botId);

    try {
      await running.bot.stop();
    } catch (err) {
      console.error(`[telegram] failed to stop bot ${botId}:`, err);
    }

    this.runningBots.delete(botId);
    console.log(`[telegram] bot stopped: ${botId}`);
  }
}

export const telegramService = new TelegramService();
