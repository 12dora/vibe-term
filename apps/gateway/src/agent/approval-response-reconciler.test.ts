import { describe, expect, test } from 'bun:test';
import {
  type ApprovalConfirmationLike,
  type ApprovalMessageLike,
  type InspectedApprovals,
  buildApprovalResponsePlan,
  inspectApprovalMessages,
} from './approval-response-reconciler';

function message(role: string, parts: unknown[]): ApprovalMessageLike {
  return { role, content: { content: parts } };
}

function confirmation(
  overrides: Partial<ApprovalConfirmationLike> & Pick<ApprovalConfirmationLike, 'toolCallId'>
): ApprovalConfirmationLike {
  return {
    status: 'approved',
    toolName: 'send_input',
    reason: null,
    ...overrides,
  };
}

function requireInspected(messages: ApprovalMessageLike[]): InspectedApprovals {
  const inspected = inspectApprovalMessages(messages);
  if (!inspected) {
    throw new Error('expected inspectApprovalMessages to return an inspection');
  }
  return inspected;
}

const requestA = {
  type: 'tool-approval-request',
  approvalId: 'appr-a',
  toolCallId: 'call-a',
};
const requestB = {
  type: 'tool-approval-request',
  approvalId: 'appr-b',
  toolCallId: 'call-b',
};

describe('inspectApprovalMessages', () => {
  test('无消息或无 assistant 时返回 null', () => {
    expect(inspectApprovalMessages([])).toBeNull();
    expect(inspectApprovalMessages([message('user', [{ type: 'text', text: 'hi' }])])).toBeNull();
  });

  test('最后一条 assistant 内容非数组或没有 approval-request 时返回 null', () => {
    expect(inspectApprovalMessages([{ role: 'assistant', content: 'plain' }])).toBeNull();
    expect(
      inspectApprovalMessages([{ role: 'assistant', content: { content: { nested: true } } }])
    ).toBeNull();
    expect(
      inspectApprovalMessages([message('assistant', [{ type: 'text', text: 'ok' }])])
    ).toBeNull();
  });

  test('只看最后一条 assistant，并收集其后 tool 消息中的 approval-response / tool-result', () => {
    const inspected = requireInspected([
      message('assistant', [requestA]),
      message('user', [{ type: 'tool-approval-response', approvalId: 'appr-stale' }]),
      message('assistant', [requestA, requestB, { type: 'text', text: 'ignore' }]),
      message('user', [{ type: 'tool-result', toolCallId: 'call-ignored' }]),
      { role: 'tool', content: { content: 'not-array' } },
      message('tool', [
        { type: 'tool-approval-response', approvalId: 'appr-a' },
        { type: 'tool-result', toolCallId: 'call-b' },
        { type: 'text', text: 'noise' },
        { type: 'tool-approval-response', approvalId: 12 },
        { type: 'tool-result', toolCallId: 7 },
      ]),
    ]);

    expect(inspected.requests).toEqual([requestA, requestB]);
    expect([...inspected.respondedApprovalIds]).toEqual(['appr-a']);
    expect([...inspected.resolvedToolCallIds]).toEqual(['call-b']);
  });

  test('approvalId 非 string 的 approval-request 不入列', () => {
    const inspected = requireInspected([
      message('assistant', [
        { type: 'tool-approval-request', approvalId: 1, toolCallId: 'call-x' },
        requestA,
      ]),
    ]);
    expect(inspected.requests).toEqual([requestA]);
    expect(inspected.respondedApprovalIds.size).toBe(0);
    expect(inspected.resolvedToolCallIds.size).toBe(0);
  });
});

describe('buildApprovalResponsePlan', () => {
  const inspectedBoth = requireInspected([message('assistant', [requestA, requestB])]);

  test('已有 approval-response 优先于 confirmation 状态 → already-ready', () => {
    const inspected = requireInspected([
      message('assistant', [requestA]),
      message('tool', [{ type: 'tool-approval-response', approvalId: 'appr-a' }]),
    ]);
    const plan = buildApprovalResponsePlan(
      inspected,
      new Map([['appr-a', confirmation({ toolCallId: 'call-a', status: 'pending' })]])
    );
    expect(plan).toEqual({ kind: 'already-ready' });
  });

  test('已有 tool-result（按 confirmation.toolCallId，否则 request.toolCallId）视为已解决', () => {
    const viaRequest = requireInspected([
      message('assistant', [requestA]),
      message('tool', [{ type: 'tool-result', toolCallId: 'call-a' }]),
    ]);
    expect(buildApprovalResponsePlan(viaRequest, new Map([['appr-a', null]]))).toEqual({
      kind: 'already-ready',
    });

    const viaConfirmation = requireInspected([
      message('assistant', [requestA]),
      message('tool', [{ type: 'tool-result', toolCallId: 'canonical-call' }]),
    ]);
    expect(
      buildApprovalResponsePlan(
        viaConfirmation,
        new Map([['appr-a', confirmation({ toolCallId: 'canonical-call', status: 'pending' })]])
      )
    ).toEqual({ kind: 'already-ready' });
  });

  test('pending 或找不到 confirmation 时 not-ready，且不产出部分 parts', () => {
    expect(
      buildApprovalResponsePlan(
        inspectedBoth,
        new Map([
          ['appr-a', confirmation({ toolCallId: 'call-a', status: 'approved' })],
          ['appr-b', confirmation({ toolCallId: 'call-b', status: 'pending' })],
        ])
      )
    ).toEqual({ kind: 'not-ready' });

    expect(buildApprovalResponsePlan(inspectedBoth, new Map([['appr-a', null]]))).toEqual({
      kind: 'not-ready',
    });
  });

  test('cancelled → execution-denied tool-result（reason 缺省为 cancelled）', () => {
    const inspected = requireInspected([message('assistant', [requestA])]);
    expect(
      buildApprovalResponsePlan(
        inspected,
        new Map([
          [
            'appr-a',
            confirmation({
              toolCallId: 'call-a',
              toolName: 'run_command',
              status: 'cancelled',
              reason: null,
            }),
          ],
        ])
      )
    ).toEqual({
      kind: 'append',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'call-a',
          toolName: 'run_command',
          output: { type: 'execution-denied', reason: 'cancelled' },
        },
      ],
    });
  });

  test('approved / denied 生成 tool-approval-response；denied 仅在有 reason 时带上', () => {
    const plan = buildApprovalResponsePlan(
      inspectedBoth,
      new Map([
        ['appr-a', confirmation({ toolCallId: 'call-a', status: 'approved', reason: 'unused' })],
        [
          'appr-b',
          confirmation({
            toolCallId: 'call-b',
            status: 'denied',
            reason: 'too risky',
          }),
        ],
      ])
    );
    expect(plan).toEqual({
      kind: 'append',
      parts: [
        { type: 'tool-approval-response', approvalId: 'appr-a', approved: true },
        {
          type: 'tool-approval-response',
          approvalId: 'appr-b',
          approved: false,
          reason: 'too risky',
        },
      ],
    });

    const deniedNoReason = requireInspected([message('assistant', [requestB])]);
    expect(
      buildApprovalResponsePlan(
        deniedNoReason,
        new Map([
          ['appr-b', confirmation({ toolCallId: 'call-b', status: 'denied', reason: null })],
        ])
      )
    ).toEqual({
      kind: 'append',
      parts: [{ type: 'tool-approval-response', approvalId: 'appr-b', approved: false }],
    });
  });

  test('cancelled 自定义 reason 原样写入 execution-denied', () => {
    const inspected = requireInspected([message('assistant', [requestA])]);
    const plan = buildApprovalResponsePlan(
      inspected,
      new Map([
        [
          'appr-a',
          confirmation({ toolCallId: 'call-a', status: 'cancelled', reason: 'user-stop' }),
        ],
      ])
    );
    expect(plan.kind).toBe('append');
    if (plan.kind === 'append') {
      expect(plan.parts[0]).toMatchObject({
        output: { type: 'execution-denied', reason: 'user-stop' },
      });
    }
  });
});
