import type { FlagValues } from '../core/args';
import { type SubHandler, confirmOrYes, rejectExtra, requireArg } from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { telegramBotBody, weixinAccountBody } from '../core/settings-body';
import { jsonSelf, print } from './settings-http';

function resourcePath(collection: string, id: string, suffix = ''): string {
  return `${collection}/${encodeURIComponent(id)}${suffix}`;
}

type ParentCrudSpec = {
  listPath: string;
  idLabel: string;
  confirmKind: string;
  body: (ctx: CliContext, flags: FlagValues, required: boolean) => Promise<unknown>;
};

async function runParentLsAddEditRm(
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[],
  spec: ParentCrudSpec
): Promise<boolean> {
  const action = positionals[0];
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', spec.listPath));
    return true;
  }
  if (action === 'add') {
    print(ctx, await jsonSelf(ctx, 'POST', spec.listPath, await spec.body(ctx, flags, true)));
    return true;
  }
  if (action === 'edit') {
    const id = requireArg(positionals, 1, spec.idLabel);
    rejectExtra(positionals, 2);
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        resourcePath(spec.listPath, id),
        await spec.body(ctx, flags, false)
      )
    );
    return true;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, spec.idLabel);
    rejectExtra(positionals, 2);
    await confirmOrYes(flags, `delete ${spec.confirmKind} ${id}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', resourcePath(spec.listPath, id)));
    return true;
  }
  return false;
}

const TELEGRAM_BOTS = '/api/settings/telegram/bots';
const WEIXIN_ACCOUNTS = '/api/settings/weixin/accounts';

async function telegramChats(
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[]
): Promise<void> {
  const chatAction = requireArg(positionals, 1, 'ls|approve|test|rm');
  const botId = requireArg(positionals, 2, 'bot id');
  const chatsBase = resourcePath(TELEGRAM_BOTS, botId, '/chats');
  if (chatAction === 'ls') {
    rejectExtra(positionals, 3);
    print(ctx, await jsonSelf(ctx, 'GET', chatsBase));
    return;
  }
  const chatId = requireArg(positionals, 3, 'chat id');
  rejectExtra(positionals, 4);
  if (chatAction === 'approve') {
    print(ctx, await jsonSelf(ctx, 'POST', resourcePath(chatsBase, chatId, '/approve')));
    return;
  }
  if (chatAction === 'test') {
    print(ctx, await jsonSelf(ctx, 'POST', resourcePath(chatsBase, chatId, '/test')));
    return;
  }
  if (chatAction === 'rm') {
    await confirmOrYes(flags, `delete telegram chat ${chatId}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', resourcePath(chatsBase, chatId)));
    return;
  }
  throw new UsageError(`unknown telegram chats action: ${chatAction}`, 'use ls|approve|test|rm');
}

export const telegram: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|add|edit|rm|chats');
  const handled = await runParentLsAddEditRm(ctx, flags, positionals, {
    listPath: TELEGRAM_BOTS,
    idLabel: 'bot id',
    confirmKind: 'telegram bot',
    body: (c, f, required) => telegramBotBody(c, f, required),
  });
  if (handled) return;
  if (action !== 'chats') {
    throw new UsageError(`unknown telegram action: ${action}`, 'use ls|add|edit|rm|chats');
  }
  await telegramChats(ctx, flags, positionals);
};

async function weixinLogin(ctx: CliContext, positionals: string[]): Promise<void> {
  const sub = requireArg(positionals, 1, 'start|status');
  const id = requireArg(positionals, 2, 'account id');
  rejectExtra(positionals, 3);
  if (sub === 'start') {
    print(ctx, await jsonSelf(ctx, 'POST', resourcePath(WEIXIN_ACCOUNTS, id, '/login/start')));
    return;
  }
  if (sub === 'status') {
    print(ctx, await jsonSelf(ctx, 'GET', resourcePath(WEIXIN_ACCOUNTS, id, '/login/status')));
    return;
  }
  throw new UsageError(`unknown weixin login action: ${sub}`, 'use start|status');
}

async function weixinUsers(ctx: CliContext, positionals: string[]): Promise<void> {
  const userAction = requireArg(positionals, 1, 'ls|approve');
  const accountId = requireArg(positionals, 2, 'account id');
  if (userAction === 'ls') {
    rejectExtra(positionals, 3);
    print(ctx, await jsonSelf(ctx, 'GET', resourcePath(WEIXIN_ACCOUNTS, accountId, '/users')));
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
        `${resourcePath(WEIXIN_ACCOUNTS, accountId, '/users')}/${encodeURIComponent(userId)}/approve`
      )
    );
    return;
  }
  throw new UsageError(`unknown weixin users action: ${userAction}`, 'use ls|approve');
}

export const weixin: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|add|edit|rm|test|login|users');
  const handled = await runParentLsAddEditRm(ctx, flags, positionals, {
    listPath: WEIXIN_ACCOUNTS,
    idLabel: 'account id',
    confirmKind: 'weixin account',
    body: (_c, f, required) => weixinAccountBody(f, required),
  });
  if (handled) return;
  if (action === 'test') {
    const id = requireArg(positionals, 1, 'account id');
    rejectExtra(positionals, 2);
    print(ctx, await jsonSelf(ctx, 'POST', resourcePath(WEIXIN_ACCOUNTS, id, '/test')));
    return;
  }
  if (action === 'login') {
    await weixinLogin(ctx, positionals);
    return;
  }
  if (action !== 'users') {
    throw new UsageError(`unknown weixin action: ${action}`, 'use ls|add|edit|rm|test|login|users');
  }
  await weixinUsers(ctx, positionals);
};
