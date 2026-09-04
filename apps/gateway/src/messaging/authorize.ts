import type { CommandActor } from '@tmex/shared/messaging';
import { getTelegramBotById, getTelegramChatByBotAndChatId } from '../db/telegram';
import { getWeixinAccountById, getWeixinUserByAccountAndUserId } from '../db/weixin';

export type AuthDecision = { ok: true } | { ok: false; silent: true };

function isGroupChat(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

function authorizeTelegram(actor: CommandActor): AuthDecision {
  const bot = getTelegramBotById(actor.accountId);
  if (!bot?.allowCommands) return { ok: false, silent: true };
  const chat = getTelegramChatByBotAndChatId(actor.accountId, actor.conversationId);
  if (!chat || chat.status !== 'authorized') return { ok: false, silent: true };
  if (isGroupChat(chat.chatType)) {
    if (!chat.userId || !actor.userId || chat.userId !== actor.userId) {
      return { ok: false, silent: true };
    }
  }
  return { ok: true };
}

function authorizeWeixin(actor: CommandActor): AuthDecision {
  const account = getWeixinAccountById(actor.accountId);
  if (!account?.allowCommands) return { ok: false, silent: true };
  const user = getWeixinUserByAccountAndUserId(actor.accountId, actor.conversationId);
  if (!user || user.status !== 'authorized') return { ok: false, silent: true };
  return { ok: true };
}

export function authorizeMessagingActor(actor: CommandActor): AuthDecision {
  if (actor.platform === 'telegram') return authorizeTelegram(actor);
  if (actor.platform === 'weixin') return authorizeWeixin(actor);
  return { ok: false, silent: true };
}
