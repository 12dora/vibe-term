// 节点详情框：脏检查（只发真正改过的那条动作）、域名访问的读写通道与不支持的降级。
// 无 DOM 测试环境，正文用 react-dom/server 静态渲染，交互靠导出的纯函数 / 注入 IO 驱动。

import { afterEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { DomainAccessPolicy } from '@tmex/api-client';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const {
  DomainAccessConfirm,
  DomainAccessConfirmBody,
  NodeDetailBody,
  createNodeDetailIo,
  domainAccessNote,
  hasNodeDetailChanges,
  loadDomainAccessState,
  nodeDetailClient,
  planNodeDetailSave,
  saveNodeDetail,
  toggleDomainAccess,
} = await import('./node-detail-dialog');

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function nodeRow(overrides: Partial<NodeRow> & { id: string }): NodeRow {
  return {
    runtimeNodeId: overrides.id,
    name: 'studio',
    publicKey: '',
    fingerprint: 'ffffffffffffffff',
    online: true,
    reach: 'lan',
    transport: null,
    rttMs: null,
    version: '1.1.9',
    directCapable: false,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    isHub: false,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    ...overrides,
  };
}

const REMOTE = nodeRow({ id: '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d' });
const SELF = nodeRow({
  id: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  runtimeNodeId: 'self',
  isSelf: true,
});

function policy(overrides: Partial<DomainAccessPolicy> = {}): DomainAccessPolicy {
  return { allowed: true, viaDomain: false, hosts: ['tmex.example.com'], ...overrides };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 记录请求并按需回一个响应；断言 URL 用它，不去猜 ApiClient 内部怎么拼。 */
function stubFetch(respond: (url: string, init?: RequestInit) => Response): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    urls.push(String(input));
    return Promise.resolve(respond(String(input), init));
  }) as typeof fetch;
  return { urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('域名访问的请求通道', () => {
  test('远端节点走 `/n/<id>` 前缀，本机不带前缀', () => {
    expect(nodeDetailClient(REMOTE).baseUrl).toBe(`/n/${REMOTE.id}`);
    expect(nodeDetailClient(SELF).baseUrl).toBe('');
  });

  test('读远端节点的策略：URL 带 node 前缀', async () => {
    const calls = stubFetch(() => json(policy()));
    const state = await loadDomainAccessState(
      REMOTE,
      createNodeDetailIo(async () => {}),
      t
    );

    expect(calls.urls).toEqual([`/n/${REMOTE.id}/api/system/domain-access`]);
    expect(state).toEqual({
      kind: 'ready',
      allowed: true,
      viaDomain: false,
      hosts: ['tmex.example.com'],
    });
  });

  test('写本机的策略：PATCH 打到入口自身', async () => {
    const calls = stubFetch(() => json(policy({ allowed: false })));
    await createNodeDetailIo(async () => {}).saveDomainAccess(SELF, false);

    expect(calls.urls).toEqual(['/api/system/domain-access']);
  });

  test('老节点回 404：折成「该节点版本不支持」而不是一条报错', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404));
    const state = await loadDomainAccessState(
      REMOTE,
      createNodeDetailIo(async () => {}),
      t
    );

    expect(state).toEqual({ kind: 'unsupported' });
    expect(domainAccessNote(state, t)).toBe('nodes.detail.domainAccessUnsupported');
  });

  test('其它失败保留原因，供正文提示', async () => {
    stubFetch(() => json({ error: 'boom' }, 500));
    const state = await loadDomainAccessState(
      REMOTE,
      createNodeDetailIo(async () => {}),
      t
    );

    expect(state.kind).toBe('failed');
    expect(domainAccessNote(state, t)).toContain('nodes.detail.domainAccessFailed');
  });
});

describe('脏检查', () => {
  const baseline = { name: 'studio', allowed: true };

  test('什么都没动：保存不可点', () => {
    const plan = planNodeDetailSave(baseline, { name: 'studio', allowed: true });

    expect(plan).toEqual({ renameTo: null, allowed: null });
    expect(hasNodeDetailChanges(plan)).toBe(false);
  });

  test('名字只是多了空白：不算改名', () => {
    expect(planNodeDetailSave(baseline, { name: '  studio  ', allowed: true }).renameTo).toBeNull();
  });

  test('名字被清空：不发一条把节点改成空名的 rename', () => {
    expect(planNodeDetailSave(baseline, { name: '   ', allowed: true }).renameTo).toBeNull();
  });

  test('只改名字：不动域名访问', () => {
    expect(planNodeDetailSave(baseline, { name: 'laptop', allowed: true })).toEqual({
      renameTo: 'laptop',
      allowed: null,
    });
  });

  test('只关域名访问：不发 rename', () => {
    expect(planNodeDetailSave(baseline, { name: 'studio', allowed: false })).toEqual({
      renameTo: null,
      allowed: false,
    });
  });

  test('域名访问没读到（不支持 / 失败）：这一项永远不参与保存', () => {
    const unknown = { name: 'studio', allowed: null };
    expect(planNodeDetailSave(unknown, { name: 'studio', allowed: null }).allowed).toBeNull();
    expect(planNodeDetailSave(unknown, { name: 'laptop', allowed: null })).toEqual({
      renameTo: 'laptop',
      allowed: null,
    });
  });
});

describe('保存', () => {
  function io(overrides: Partial<Parameters<typeof saveNodeDetail>[2]> = {}) {
    const calls = { renamed: [] as string[], allowed: [] as boolean[] };
    return {
      calls,
      io: {
        loadDomainAccess: async () => policy(),
        saveDomainAccess: async (_row: NodeRow, allowed: boolean) => {
          calls.allowed.push(allowed);
          return policy({ allowed });
        },
        rename: async (name: string) => {
          calls.renamed.push(name);
        },
        ...overrides,
      },
    };
  }

  const ctx = { t, writerPublicUrl: null };

  test('名字没变：一条 rename 都不发', async () => {
    const { io: fake, calls } = io();
    const plan = planNodeDetailSave(
      { name: 'studio', allowed: true },
      {
        name: 'studio',
        allowed: false,
      }
    );
    const result = await saveNodeDetail(REMOTE, plan, fake, ctx);

    expect(calls.renamed).toEqual([]);
    expect(calls.allowed).toEqual([false]);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('两项都改：两条动作各发一次', async () => {
    const { io: fake, calls } = io();
    const plan = planNodeDetailSave(
      { name: 'studio', allowed: true },
      {
        name: 'laptop',
        allowed: false,
      }
    );
    await saveNodeDetail(REMOTE, plan, fake, ctx);

    expect(calls.renamed).toEqual(['laptop']);
    expect(calls.allowed).toEqual([false]);
  });

  test('改名失败不吞掉域名访问：两条错误分别报，且另一条照样执行', async () => {
    const { io: fake, calls } = io({
      rename: async () => {
        throw new Error('rename boom');
      },
    });
    const plan = planNodeDetailSave(
      { name: 'studio', allowed: true },
      {
        name: 'laptop',
        allowed: false,
      }
    );
    const result = await saveNodeDetail(REMOTE, plan, fake, ctx);

    expect(calls.allowed).toEqual([false]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('nodes.detail.renameFailed');
  });

  test('域名访问写失败：单独一条错误', async () => {
    const { io: fake } = io({
      saveDomainAccess: async () => {
        throw new Error('patch boom');
      },
    });
    const plan = planNodeDetailSave(
      { name: 'studio', allowed: true },
      {
        name: 'studio',
        allowed: false,
      }
    );
    const result = await saveNodeDetail(REMOTE, plan, fake, ctx);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('nodes.detail.domainAccessSaveFailed');
  });
});

describe('关闭域名访问要先确认', () => {
  test('打开直接生效，关闭走确认框', () => {
    expect(toggleDomainAccess(true)).toEqual({ kind: 'apply', allowed: true });
    expect(toggleDomainAccess(false)).toEqual({ kind: 'confirm' });
  });

  test('确认框：正经由该域名访问时多一条失联警告', () => {
    const via = renderToStaticMarkup(<DomainAccessConfirmBody viaDomain testId="c" />);
    expect(via).toContain('data-testid="c-self-warning"');
    expect(via).toContain('nodes.detail.disableSelfWarning');

    expect(renderToStaticMarkup(<DomainAccessConfirmBody viaDomain={false} testId="c" />)).toBe('');
  });

  test('未请求关闭时不渲染', () => {
    const html = renderToStaticMarkup(
      <DomainAccessConfirm
        open={false}
        viaDomain
        onCancel={() => undefined}
        onConfirm={() => undefined}
        testId="c"
      />
    );
    expect(html).toBe('');
  });
});

describe('详情正文', () => {
  function body(overrides: Partial<Parameters<typeof NodeDetailBody>[0]> = {}): string {
    return renderToStaticMarkup(
      <NodeDetailBody
        row={REMOTE}
        name={REMOTE.name}
        onNameChange={() => undefined}
        renameAvailable
        domainAccess={{ kind: 'ready', allowed: true, viaDomain: false, hosts: [] }}
        allowed={true}
        onAllowedChange={() => undefined}
        errors={[]}
        {...overrides}
      />
    );
  }

  test('打开时带着这一行的只读信息与当前值', () => {
    const html = body();
    expect(html).toContain(`data-testid="nodes-detail-info-${REMOTE.id}"`);
    expect(html).toContain(REMOTE.id.slice(0, 8));
    expect(html).toContain('ffffffffffffffff');
    expect(html).toContain('1.1.9');
    expect(html).toContain('nodes.reach.lan');
    expect(html).toContain(`value="${REMOTE.name}"`);
    expect(html).toContain(`data-testid="nodes-detail-domain-${REMOTE.id}"`);
  });

  test('hub 不可写时名称输入框禁用并说明原因', () => {
    const html = body({ renameAvailable: false });
    expect(html).toContain('nodes.detail.renameUnavailable');
    const at = html.indexOf(`data-testid="nodes-detail-name-input-${REMOTE.id}"`);
    expect(html.slice(html.lastIndexOf('<input', at), at)).toContain('disabled=""');
  });

  test('域名访问不支持时开关锁住', () => {
    const html = body({ domainAccess: { kind: 'unsupported' }, allowed: null });
    expect(html).toContain('nodes.detail.domainAccessUnsupported');
    const at = html.indexOf(`data-testid="nodes-detail-domain-${REMOTE.id}"`);
    expect(html.slice(html.lastIndexOf('<button', at), at)).toContain('disabled=""');
  });

  test('保存失败的原因逐条列出', () => {
    const html = body({ errors: ['nodes.detail.renameFailed'] });
    expect(html).toContain(`data-testid="nodes-detail-errors-${REMOTE.id}"`);
    expect(html).toContain('nodes.detail.renameFailed');
  });
});
