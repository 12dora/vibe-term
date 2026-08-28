import { describe, expect, test } from 'bun:test';
import {
  type ApprovalConfirmation,
  type ApprovalMessageLike,
  type ApprovalRequest,
  buildApprovalResponseParts,
  collectResolvedToolCalls,
  findApprovalRequests,
} from './approval-response-reconciler';

function msg(role: string, parts: unknown): ApprovalMessageLike {
  return { role, content: { role, content: parts } };
}

function request(approvalId: string, toolCallId: string): ApprovalRequest {
  return { approvalId, toolCallId };
}

function confirmation(
  approvalId: string,
  status: ApprovalConfirmation['status'],
  overrides: Partial<Omit<ApprovalConfirmation, 'approvalId' | 'status'>> = {}
): ApprovalConfirmation {
  return {
    approvalId,
    toolCallId: `call_${approvalId}`,
    toolName: 'send_input',
    status,
    reason: null,
    ...overrides,
  };
}

describe('findApprovalRequests', () => {
  test('没有 assistant 或没有 approval-request → absent', () => {
    expect(findApprovalRequests([])).toEqual({ kind: 'absent' });
    expect(findApprovalRequests([msg('user', 'hi')])).toEqual({ kind: 'absent' });
    expect(findApprovalRequests([msg('assistant', [{ type: 'text', text: 'ok' }])])).toEqual({
      kind: 'absent',
    });
    expect(findApprovalRequests([{ role: 'assistant', content: 'plain' }])).toEqual({
      kind: 'absent',
    });
  });

  test('只扫描最后一条 assistant 的 tool-approval-request', () => {
    const messages = [
      msg('assistant', [
        { type: 'tool-approval-request', approvalId: 'old', toolCallId: 'call_old' },
      ]),
      msg('user', 'continue'),
      msg('assistant', [
        { type: 'text', text: 'need confirm' },
        { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'call_1' },
        { type: 'tool-approval-request', approvalId: 'a2', toolCallId: 'call_2' },
        { type: 'tool-call', toolCallId: 'call_1' },
      ]),
    ];
    expect(findApprovalRequests(messages)).toEqual({
      kind: 'open',
      requests: [request('a1', 'call_1'), request('a2', 'call_2')],
    });
  });

  test('后续 tool 消息里已有 approval-response 或 tool-result 的请求视为已决议', () => {
    const messages = [
      msg('assistant', [
        { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'call_1' },
        { type: 'tool-approval-request', approvalId: 'a2', toolCallId: 'call_2' },
        { type: 'tool-approval-request', approvalId: 'a3', toolCallId: 'call_3' },
      ]),
      msg('user', 'ignored'),
      msg('tool', [
        { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        { type: 'tool-result', toolCallId: 'call_2', toolName: 'send_input' },
      ]),
    ];
    expect(findApprovalRequests(messages)).toEqual({
      kind: 'open',
      requests: [request('a3', 'call_3')],
    });
  });

  test('全部请求都已在后续 tool 消息中决议 → complete', () => {
    const messages = [
      msg('assistant', [{ type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'call_1' }]),
      msg('tool', [{ type: 'tool-approval-response', approvalId: 'a1', approved: false }]),
    ];
    expect(findApprovalRequests(messages)).toEqual({ kind: 'complete' });
  });

  test('approvalId 非字符串的 part 忽略；缺失 toolCallId 记为空串', () => {
    const messages = [
      msg('assistant', [
        { type: 'tool-approval-request', approvalId: 1, toolCallId: 'call_x' },
        { type: 'tool-approval-request', approvalId: 'a1' },
      ]),
    ];
    expect(findApprovalRequests(messages)).toEqual({
      kind: 'open',
      requests: [request('a1', '')],
    });
  });
});

describe('collectResolvedToolCalls', () => {
  test('mixed approved / denied / cancelled 按请求顺序产出决议', () => {
    const resolved = collectResolvedToolCalls(
      [request('a1', 'call_1'), request('a2', 'call_2'), request('a3', 'call_3')],
      [
        confirmation('a1', 'approved'),
        confirmation('a2', 'denied', { reason: 'too risky', toolCallId: 'call_2' }),
        confirmation('a3', 'cancelled', { reason: 'stopped by user', toolCallId: 'call_3' }),
      ]
    );
    expect(resolved).toEqual([
      { status: 'approved', approvalId: 'a1', approved: true, reason: null },
      { status: 'denied', approvalId: 'a2', approved: false, reason: 'too risky' },
      {
        status: 'cancelled',
        toolCallId: 'call_3',
        toolName: 'send_input',
        reason: 'stopped by user',
      },
    ]);
  });

  test('unmatched tool calls 或 pending confirmation → 整批未就绪', () => {
    expect(
      collectResolvedToolCalls(
        [request('a1', 'call_1'), request('a2', 'call_2')],
        [confirmation('a1', 'approved')]
      )
    ).toBeNull();
    expect(
      collectResolvedToolCalls([request('a1', 'call_1')], [confirmation('a1', 'pending')])
    ).toBeNull();
    expect(collectResolvedToolCalls([request('a1', 'call_1')], [])).toBeNull();
  });

  test('duplicate confirmations：同一 approvalId 只取第一条，不产出重复决议', () => {
    const resolved = collectResolvedToolCalls(
      [request('a1', 'call_1')],
      [
        confirmation('a1', 'approved', { toolCallId: 'call_1' }),
        confirmation('a1', 'denied', { reason: 'later', toolCallId: 'call_1' }),
      ]
    );
    expect(resolved).toEqual([
      { status: 'approved', approvalId: 'a1', approved: true, reason: null },
    ]);
  });

  test('cancelled 无 reason 时回落到 cancelled', () => {
    expect(
      collectResolvedToolCalls(
        [request('a1', 'call_1')],
        [confirmation('a1', 'cancelled', { toolCallId: 'call_1', reason: null })]
      )
    ).toEqual([
      {
        status: 'cancelled',
        toolCallId: 'call_1',
        toolName: 'send_input',
        reason: 'cancelled',
      },
    ]);
  });
});

describe('buildApprovalResponseParts', () => {
  test('mixed approved / denied / cancelled 分别生成 response 与 execution-denied', () => {
    const parts = buildApprovalResponseParts([
      { status: 'approved', approvalId: 'a1', approved: true, reason: 'ignored' },
      { status: 'denied', approvalId: 'a2', approved: false, reason: 'too risky' },
      { status: 'denied', approvalId: 'a3', approved: false, reason: null },
      {
        status: 'cancelled',
        toolCallId: 'call_4',
        toolName: 'send_input',
        reason: 'stopped by user',
      },
    ]);
    expect(parts).toEqual([
      { type: 'tool-approval-response', approvalId: 'a1', approved: true },
      {
        type: 'tool-approval-response',
        approvalId: 'a2',
        approved: false,
        reason: 'too risky',
      },
      { type: 'tool-approval-response', approvalId: 'a3', approved: false },
      {
        type: 'tool-result',
        toolCallId: 'call_4',
        toolName: 'send_input',
        output: { type: 'execution-denied', reason: 'stopped by user' },
      },
    ]);
  });
});
