import { type SubHandler, confirmOrYes, rejectExtra, requireArg } from '../core/cmd';
import { UsageError } from '../core/errors';
import { telegramBotBody, weixinAccountBody } from '../core/settings-body';
import { jsonSelf, print } from './settings-http';

function botChatsPath(botId: string, chatId?: string, suffix = ''): string {
  const base = `/api/settings/telegram/bots/${encodeURIComponent(botId)}/chats`;
  if (!chatId) return base;
  return `${base}/${encodeURIComponent(chatId)}${suffix}`;
}

export const telegram: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|add|edit|rm|chats');
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/settings/telegram/bots'));
    return;
  }
  if (action === 'add') {
    print(
      ctx,
      await jsonSelf(
        ctx,
        'POST',
        '/api/settings/telegram/bots',
        await telegramBotBody(ctx, flags, true)
      )
    );
    return;
  }
  if (action === 'edit') {
    const id = requireArg(positionals, 1, 'bot id');
    rejectExtra(positionals, 2);
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        `/api/settings/telegram/bots/${encodeURIComponent(id)}`,
        await telegramBotBody(ctx, flags, false)
      )
    );
    return;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, 'bot id');
    rejectExtra(positionals, 2);
    await confirmOrYes(flags, `delete telegram bot ${id}`);
    print(
      ctx,
      await jsonSelf(ctx, 'DELETE', `/api/settings/telegram/bots/${encodeURIComponent(id)}`)
    );
    return;
  }
  if (action !== 'chats') {
    throw new UsageError(`unknown telegram action: ${action}`, 'use ls|add|edit|rm|chats');
  }
  const chatAction = requireArg(positionals, 1, 'ls|approve|test|rm');
  const botId = requireArg(positionals, 2, 'bot id');
  if (chatAction === 'ls') {
    rejectExtra(positionals, 3);
    print(ctx, await jsonSelf(ctx, 'GET', botChatsPath(botId)));
    return;
  }
  const chatId = requireArg(positionals, 3, 'chat id');
  rejectExtra(positionals, 4);
  if (chatAction === 'approve') {
    print(ctx, await jsonSelf(ctx, 'POST', botChatsPath(botId, chatId, '/approve')));
    return;
  }
  if (chatAction === 'test') {
    print(ctx, await jsonSelf(ctx, 'POST', botChatsPath(botId, chatId, '/test')));
    return;
  }
  if (chatAction === 'rm') {
    await confirmOrYes(flags, `delete telegram chat ${chatId}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', botChatsPath(botId, chatId)));
    return;
  }
  throw new UsageError(`unknown telegram chats action: ${chatAction}`, 'use ls|approve|test|rm');
};

function accountPath(accountId: string, suffix = ''): string {
  return `/api/settings/weixin/accounts/${encodeURIComponent(accountId)}${suffix}`;
}

export const weixin: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|add|edit|rm|test|login|users');
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/settings/weixin/accounts'));
    return;
  }
  if (action === 'add') {
    print(
      ctx,
      await jsonSelf(
        ctx,
        'POST',
        '/api/settings/weixin/accounts',
        await weixinAccountBody(flags, true)
      )
    );
    return;
  }
  if (action === 'edit') {
    const id = requireArg(positionals, 1, 'account id');
    rejectExtra(positionals, 2);
    print(
      ctx,
      await jsonSelf(ctx, 'PATCH', accountPath(id), await weixinAccountBody(flags, false))
    );
    return;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, 'account id');
    rejectExtra(positionals, 2);
    await confirmOrYes(flags, `delete weixin account ${id}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', accountPath(id)));
    return;
  }
  if (action === 'test') {
    const id = requireArg(positionals, 1, 'account id');
    rejectExtra(positionals, 2);
    print(ctx, await jsonSelf(ctx, 'POST', accountPath(id, '/test')));
    return;
  }
  if (action === 'login') {
    const sub = requireArg(positionals, 1, 'start|status');
    const id = requireArg(positionals, 2, 'account id');
    rejectExtra(positionals, 3);
    if (sub === 'start') {
      print(ctx, await jsonSelf(ctx, 'POST', accountPath(id, '/login/start')));
      return;
    }
    if (sub === 'status') {
      print(ctx, await jsonSelf(ctx, 'GET', accountPath(id, '/login/status')));
      return;
    }
    throw new UsageError(`unknown weixin login action: ${sub}`, 'use start|status');
  }
  if (action !== 'users') {
    throw new UsageError(`unknown weixin action: ${action}`, 'use ls|add|edit|rm|test|login|users');
  }
  const userAction = requireArg(positionals, 1, 'ls|approve');
  const accountId = requireArg(positionals, 2, 'account id');
  if (userAction === 'ls') {
    rejectExtra(positionals, 3);
    print(ctx, await jsonSelf(ctx, 'GET', accountPath(accountId, '/users')));
    return;
  }
  if (userAction === 'approve') {
    const userId = requireArg(positionals, 3, 'user id');
    rejectExtra(positionals, 4);
    print(
      ctx,
      await jsonSelf(
        ctx,
        'POST',
        `${accountPath(accountId, '/users')}/${encodeURIComponent(userId)}/approve`
      )
    );
    return;
  }
  throw new UsageError(`unknown weixin users action: ${userAction}`, 'use ls|approve');
};
