// 线程块拼装：把 store 中的消息、在途增量与待确认工具调用合成视图块。

import type { AgentMessageDto } from '@tmex/shared';
import type { PendingConfirmationUi, SessionInProgress, UiThreadBlock } from '@tmex/stores';
import { buildThreadBlocks } from '@tmex/stores';

type Confirmations = PendingConfirmationUi[] | undefined;

export function buildConfirmationMap(confirmations: Confirmations): Map<string, string> {
  const map = new Map<string, string>();
  for (const confirmation of confirmations ?? []) {
    map.set(confirmation.toolCallId, confirmation.id);
  }
  return map;
}

function confirmationBlock(confirmation: PendingConfirmationUi): UiThreadBlock {
  return {
    kind: 'tool-call',
    key: `confirmation-${confirmation.id}`,
    call: {
      toolCallId: confirmation.toolCallId,
      toolName: confirmation.toolName,
      input: confirmation.input,
      isError: false,
      denied: false,
      resolved: false,
    },
  };
}

export function buildBlocksWithConfirmations(
  messages: AgentMessageDto[] | undefined,
  inProgress: SessionInProgress | undefined,
  confirmations: Confirmations
): UiThreadBlock[] {
  const merged = buildThreadBlocks(messages, inProgress);
  if (!confirmations || confirmations.length === 0) return merged;
  const knownToolCallIds = new Set<string>();
  for (const block of merged) {
    if (block.kind === 'tool-call') {
      knownToolCallIds.add(block.call.toolCallId);
    }
  }
  const extras = (confirmations ?? [])
    .filter((confirmation) => !knownToolCallIds.has(confirmation.toolCallId))
    .map(confirmationBlock);
  return extras.length > 0 ? [...merged, ...extras] : merged;
}
