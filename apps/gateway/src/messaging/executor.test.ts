import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { CommandActor, CommandInvocation } from '@tmex/shared/messaging';
import * as authorize from './authorize';
import { dispatchCommand, dispatchInboundText } from './executor';
import { createTestContext } from './test-context';

const actor: CommandActor = {
  platform: 'telegram',
  accountId: 'bot-1',
  conversationId: 'chat-1',
  userId: '42',
};

function invocation(command: string, extra: Partial<CommandInvocation> = {}): CommandInvocation {
  return {
    command,
    args: [],
    rawText: `/${command}`,
    actor,
    ...extra,
  };
}

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe('dispatchCommand authorization', () => {
  test('silences unauthorized actors', async () => {
    spies.push(
      spyOn(authorize, 'authorizeMessagingActor').mockReturnValue({ ok: false, silent: true })
    );
    const outcome = await dispatchCommand(invocation('help'), createTestContext());
    expect(outcome).toEqual({ silent: true });
  });

  test('authorized unknown command hints help', async () => {
    spies.push(spyOn(authorize, 'authorizeMessagingActor').mockReturnValue({ ok: true }));
    const outcome = await dispatchCommand(invocation('nope'), createTestContext());
    expect(outcome.silent).toBe(false);
    if (outcome.silent) return;
    expect(outcome.result.error?.code).toBe('messaging.error.unknownCommand');
    expect(outcome.result.actions?.[0]?.command).toBe('help');
  });

  test('rejects a remote node target', async () => {
    spies.push(spyOn(authorize, 'authorizeMessagingActor').mockReturnValue({ ok: true }));
    const ctx = createTestContext({
      nodes: [{ id: 'remote-1', name: 'Office', online: true, version: '1.0', current: false }],
    });
    const outcome = await dispatchCommand(invocation('status', { nodeTarget: 'Office' }), ctx);
    expect(outcome.silent).toBe(false);
    if (outcome.silent) return;
    expect(outcome.result.error?.code).toBe('messaging.error.remoteNodeUnsupported');
  });

  test('runs locally for self / empty node target', async () => {
    spies.push(spyOn(authorize, 'authorizeMessagingActor').mockReturnValue({ ok: true }));
    const outcome = await dispatchCommand(invocation('status'), createTestContext());
    expect(outcome.silent).toBe(false);
    if (outcome.silent) return;
    expect(outcome.result.sections?.[0]?.lines.some((line) => line.includes('Home'))).toBe(true);
  });
});

describe('dispatchInboundText', () => {
  test('empty text is unknown for authorized actors', async () => {
    spies.push(spyOn(authorize, 'authorizeMessagingActor').mockReturnValue({ ok: true }));
    const outcome = await dispatchInboundText('/', { actor }, createTestContext());
    expect(outcome.silent).toBe(false);
    if (outcome.silent) return;
    expect(outcome.result.error?.code).toBe('messaging.error.unknownCommand');
  });

  test('empty text stays silent when unauthorized', async () => {
    spies.push(
      spyOn(authorize, 'authorizeMessagingActor').mockReturnValue({ ok: false, silent: true })
    );
    const outcome = await dispatchInboundText('   ', { actor }, createTestContext());
    expect(outcome).toEqual({ silent: true });
  });
});
