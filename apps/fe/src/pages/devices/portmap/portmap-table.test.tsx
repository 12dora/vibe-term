import { describe, expect, test } from 'bun:test';
import type { DialogNodeOption } from '../dialog-nodes';
import { targetNodeName } from './portmap-table';
import type { PortMapRow } from './use-portmap-list';

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const OPTIONS: DialogNodeOption[] = [
  {
    id: REMOTE,
    meshId: REMOTE,
    name: 'studio',
    online: true,
    loggedIn: true,
    isSelf: false,
    usable: true,
  },
];

function row(targetNodeId: string): PortMapRow {
  return {
    id: 'm1',
    name: 'db',
    listenHost: '127.0.0.1',
    listenPort: 8080,
    targetNodeId,
    targetHost: '127.0.0.1',
    targetPort: 5432,
    paused: false,
    state: 'listening',
    activeConnections: 0,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
    createdAt: 0,
    updatedAt: 0,
    nodeId: 'self',
    nodeName: '本机',
  };
}

describe('targetNodeName', () => {
  test('按真实 mesh id 解析成节点名', () => {
    expect(targetNodeName(row(REMOTE), OPTIONS)).toBe('studio');
  });

  test('节点已不在 mesh 里时退回短 id', () => {
    expect(targetNodeName(row('abcdef0123456789'), OPTIONS)).toBe('abcdef01');
  });
});
