import { describe, expect, test } from 'bun:test';
import { type NameEditRequest, createNameEditSession, settleNameEdit } from './name-edit-settle';

function harness() {
  const calls: string[] = [];
  const handlers = {
    onCommit: (name: string) => calls.push(`commit:${name}`),
    onCancel: () => calls.push('cancel'),
  };
  return { calls, handlers, session: createNameEditSession() };
}

function request(init: Partial<NameEditRequest> = {}): NameEditRequest {
  return { commit: true, value: 'b.txt', initialName: 'a.txt', commitUnchanged: false, ...init };
}

describe('settleNameEdit', () => {
  test('Escape then the blur caused by moving focus: cancels, never commits', () => {
    const { calls, handlers, session } = harness();
    // Esc：先定局为取消
    expect(settleNameEdit(session, request({ commit: false }), handlers)).toBe(true);
    // 焦点还给列表 → 输入框同步 blur → 想提交，但已定局
    expect(settleNameEdit(session, request({ commit: true }), handlers)).toBe(false);
    expect(calls).toEqual(['cancel']);
  });

  test('Escape on a pending folder (commitUnchanged) does not create it', () => {
    const { calls, handlers, session } = harness();
    const pending = { value: '未命名文件夹', initialName: '未命名文件夹', commitUnchanged: true };
    settleNameEdit(session, request({ ...pending, commit: false }), handlers);
    settleNameEdit(session, request({ ...pending, commit: true }), handlers);
    expect(calls).toEqual(['cancel']);
  });

  test('Enter then the following blur commits exactly once', () => {
    const { calls, handlers, session } = harness();
    settleNameEdit(session, request(), handlers);
    settleNameEdit(session, request(), handlers);
    expect(calls).toEqual(['commit:b.txt']);
  });

  test('unchanged name cancels unless commitUnchanged', () => {
    const plain = harness();
    settleNameEdit(plain.session, request({ value: 'a.txt' }), plain.handlers);
    expect(plain.calls).toEqual(['cancel']);

    const pending = harness();
    settleNameEdit(
      pending.session,
      request({ value: 'a.txt', commitUnchanged: true }),
      pending.handlers
    );
    expect(pending.calls).toEqual(['commit:a.txt']);
  });

  test('a plain blur with a changed name commits; an invalid name is passed as cancel', () => {
    const blur = harness();
    settleNameEdit(blur.session, request({ commit: true }), blur.handlers);
    expect(blur.calls).toEqual(['commit:b.txt']);

    const invalid = harness();
    settleNameEdit(invalid.session, request({ commit: false, value: 'a/b' }), invalid.handlers);
    expect(invalid.calls).toEqual(['cancel']);
  });
});
