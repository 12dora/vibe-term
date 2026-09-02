// 节点详情框：脏检查（只发真正改过的那条动作）、域名访问的读写通道与不支持的降级。
// 无 DOM 测试环境，正文用 react-dom/server 静态渲染，交互靠导出的纯函数 / 注入 IO 驱动。

import { afterEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { DomainAccessPolicy } from '@tmex/api-client';
import enUS from '@tmex/shared/i18n/locales/en_US.json';
import zhCN from '@tmex/shared/i18n/locales/zh_CN.json';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { DomainAccessState } from './node-detail-dialog';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const {
  DomainAccessConfirm,
  DomainAccessConfirmBody,
  NodeDetailBody,
  createNodeDetailIo,
  domainAccessNote,
  domainAccessSwitchDisabled,
  hasNodeDetailChanges,
  loadDomainAccessState,
  nextNodeDetailBaseline,
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

  test('节点不可达（转发器 503 顶层信封）：给出人话而不是代号', async () => {
    stubFetch(() => json({ code: 'NODE_UNREACHABLE', nodeId: REMOTE.id }, 503));
    const state = await loadDomainAccessState(
      REMOTE,
      createNodeDetailIo(async () => {}),
      t
    );

    expect(state).toEqual({
      kind: 'failed',
      message: 'nodes.detail.domainAccessUnreachable',
    });
    expect(zhCN.translation.nodes.detail.domainAccessUnreachable).toBe('节点当前不可达。');
    expect(enUS.translation.nodes.detail.domainAccessUnreachable).toBe(
      'Node is currently unreachable.'
    );
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
    expect(result).toEqual({ ok: true, errors: [], renamed: false, domainSaved: true });
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

describe('一半成功一半失败后的重试', () => {
  /** 两条通道各自可控成败，并记录实际发出的请求。 */
  function io(fail: { rename?: number; domain?: number } = {}) {
    const calls = { renamed: [] as string[], allowed: [] as boolean[] };
    let renameCalls = 0;
    let domainCalls = 0;
    return {
      calls,
      io: {
        loadDomainAccess: async () => policy(),
        saveDomainAccess: async (_row: NodeRow, allowed: boolean) => {
          domainCalls += 1;
          calls.allowed.push(allowed);
          if (domainCalls <= (fail.domain ?? 0)) throw new Error('patch boom');
          return policy({ allowed });
        },
        rename: async (name: string) => {
          renameCalls += 1;
          calls.renamed.push(name);
          if (renameCalls <= (fail.rename ?? 0)) throw new Error('rename boom');
        },
      },
    };
  }

  const ctx = { t, writerPublicUrl: null };

  test('改名成功、域名访问失败：再点保存不会把名字又改一遍', async () => {
    const { io: fake, calls } = io({ domain: 1 });
    const draft = { name: 'laptop', allowed: false };
    let baseline = { name: 'studio', allowed: true as boolean | null };

    const first = planNodeDetailSave(baseline, draft);
    const firstResult = await saveNodeDetail(REMOTE, first, fake, ctx);
    expect(firstResult).toMatchObject({ ok: false, renamed: true, domainSaved: false });
    baseline = nextNodeDetailBaseline(baseline, first, firstResult);
    expect(baseline).toEqual({ name: 'laptop', allowed: true });

    const second = planNodeDetailSave(baseline, draft);
    expect(second).toEqual({ renameTo: null, allowed: false });
    const secondResult = await saveNodeDetail(REMOTE, second, fake, ctx);

    expect(secondResult).toMatchObject({ ok: true, renamed: false, domainSaved: true });
    expect(calls.renamed).toEqual(['laptop']);
    expect(calls.allowed).toEqual([false, false]);
    expect(nextNodeDetailBaseline(baseline, second, secondResult)).toEqual({
      name: 'laptop',
      allowed: false,
    });
  });

  test('域名访问成功、改名失败：再点保存不会把域名访问又写一遍', async () => {
    const { io: fake, calls } = io({ rename: 1 });
    const draft = { name: 'laptop', allowed: false };
    let baseline = { name: 'studio', allowed: true as boolean | null };

    const first = planNodeDetailSave(baseline, draft);
    const firstResult = await saveNodeDetail(REMOTE, first, fake, ctx);
    expect(firstResult).toMatchObject({ ok: false, renamed: false, domainSaved: true });
    baseline = nextNodeDetailBaseline(baseline, first, firstResult);
    expect(baseline).toEqual({ name: 'studio', allowed: false });

    const second = planNodeDetailSave(baseline, draft);
    expect(second).toEqual({ renameTo: 'laptop', allowed: null });
    await saveNodeDetail(REMOTE, second, fake, ctx);

    expect(calls.allowed).toEqual([false]);
    expect(calls.renamed).toEqual(['laptop', 'laptop']);
  });

  test('全成功：基线整体推进', () => {
    const plan = planNodeDetailSave(
      { name: 'studio', allowed: true },
      { name: 'l', allowed: false }
    );
    expect(
      nextNodeDetailBaseline({ name: 'studio', allowed: true }, plan, {
        renamed: true,
        domainSaved: true,
      })
    ).toEqual({ name: 'l', allowed: false });
  });
});

describe('没有公开域名时的开关', () => {
  const noHosts: DomainAccessState = {
    kind: 'ready',
    allowed: true,
    viaDomain: false,
    hosts: [],
  };

  test('当前开着：不给关（关了就只能从局域网开回来）', () => {
    expect(domainAccessSwitchDisabled(noHosts, true)).toBe(true);
  });

  test('当前已经关着：允许开回来', () => {
    expect(domainAccessSwitchDisabled({ ...noHosts, allowed: false }, false)).toBe(false);
  });

  test('有公开域名照旧可开可关；没读到策略一律锁住', () => {
    const ready: DomainAccessState = {
      kind: 'ready',
      allowed: true,
      viaDomain: false,
      hosts: ['a.example'],
    };
    expect(domainAccessSwitchDisabled(ready, true)).toBe(false);
    expect(domainAccessSwitchDisabled({ kind: 'unsupported' }, null)).toBe(true);
    expect(domainAccessSwitchDisabled({ kind: 'loading' }, null)).toBe(true);
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

  test('没有公开域名且当前开着：开关在正文里也是锁住的', () => {
    const html = body({
      domainAccess: { kind: 'ready', allowed: true, viaDomain: false, hosts: [] },
      allowed: true,
    });
    const at = html.indexOf(`data-testid="nodes-detail-domain-${REMOTE.id}"`);
    expect(html.slice(html.lastIndexOf('<button', at), at)).toContain('disabled=""');
  });

  test('保存失败的原因逐条列出', () => {
    const html = body({ errors: ['nodes.detail.renameFailed'] });
    expect(html).toContain(`data-testid="nodes-detail-errors-${REMOTE.id}"`);
    expect(html).toContain('nodes.detail.renameFailed');
  });
});
