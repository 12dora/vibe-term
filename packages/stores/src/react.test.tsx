// RuntimeProvider 的「换 runtime 即重挂子树」契约（回归：React error #185）。
//
// 背景：`/n/A/*` → `/n/B/*` 时 React Router 复用同一棵组件树，只有 context 值换了。宿主在
// RuntimeProvider 之内还挂着该 node 的 QueryClientProvider，而 `@tanstack/react-query` 的
// QueryObserver 在首次挂载时就和当时的 QueryClient 绑死，换 client 不会重绑：子树不重挂的话，
// 换 node 之后设备列表查询仍然读旧 node 的缓存，与新 node 的连接意图对账时会对同一台设备
// 反复 connect / disconnect，撞上 React 更新深度上限。
//
// 仓库没有 DOM 测试环境，无法真的挂载再重挂；但 React 的复用规则就是「同 type + 同 key 才复用」，
// 所以直接检查 RuntimeProvider 产出的元素：同一个 runtime 下 key 恒定（不制造多余重挂），
// 换 runtime 实例即换 key（强制重挂）。

import { describe, expect, test } from 'bun:test';
import type { ReactElement, ReactNode } from 'react';
import type { AppRuntime } from './app-runtime';
import { installWindowStorage } from './test-utils';

installWindowStorage();

const { createAppRuntime } = await import('./app-runtime');
const { RuntimeProvider, runtimeSubtreeKey } = await import('./react');

/** RuntimeProvider 包在 children 外的那层元素（重挂与否由它的 key 决定）。 */
function subtreeElement(runtime: AppRuntime, children: ReactNode): ReactElement {
  const provider = RuntimeProvider({ runtime, children }) as ReactElement<{
    children: ReactElement;
  }>;
  return provider.props.children;
}

function runtimeFor(nodeId: string): AppRuntime {
  return createAppRuntime({ nodeId, storagePrefix: `n:${nodeId}:` });
}

describe('RuntimeProvider 的子树重挂 key', () => {
  test('同一个 runtime 的 key 稳定：重复渲染不会白白重挂子树', () => {
    const runtime = runtimeFor('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
    const first = subtreeElement(runtime, <span />);
    const second = subtreeElement(runtime, <span />);

    expect(first.key).toBe(second.key);
    expect(first.type).toBe(second.type);
    expect(runtimeSubtreeKey(runtime)).toBe(runtimeSubtreeKey(runtime));
  });

  test('换 runtime 实例即换 key：React 会卸载旧子树而不是复用', () => {
    const nodeA = runtimeFor('0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
    const nodeB = runtimeFor('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const fromA = subtreeElement(nodeA, <span />);
    const fromB = subtreeElement(nodeB, <span />);

    // type 相同、只有 key 不同 —— 重挂完全由 key 驱动。
    expect(fromA.type).toBe(fromB.type);
    expect(fromA.key).not.toBe(fromB.key);
  });

  test('同 nodeId 的新 runtime 实例也换 key：runtime 被回收重建后不复用旧订阅', () => {
    const nodeId = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';
    const first = runtimeFor(nodeId);
    const rebuilt = runtimeFor(nodeId);

    expect(first).not.toBe(rebuilt);
    expect(runtimeSubtreeKey(first)).not.toBe(runtimeSubtreeKey(rebuilt));
  });

  test('children 元素本身不被改写，只是被包进带 key 的一层', () => {
    const runtime = runtimeFor('0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d');
    const children = <span data-testid="child" />;
    const subtree = subtreeElement(runtime, children) as ReactElement<{ children: ReactNode }>;

    expect(subtree.props.children).toBe(children);
    expect(subtree.key).toBe(runtimeSubtreeKey(runtime));
  });
});
