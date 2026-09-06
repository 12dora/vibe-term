// 端口探测的纯逻辑：地址改写只碰端口一段、状态机三态、过期结果一律丢弃。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import {
  type AddressProbeOutcome,
  createAddressProbeCore,
  precheckProbe,
  readAddressPort,
  replaceAddressPort,
  shouldProbeAddress,
  splitAddress,
} from './address-probe';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('replaceAddressPort', () => {
  test('只改端口，协议、主机与路径原样保留', () => {
    expect(replaceAddressPort('https://hub.example.com', 13443)).toBe(
      'https://hub.example.com:13443'
    );
    expect(replaceAddressPort('https://hub.example.com:443/base', 13443)).toBe(
      'https://hub.example.com:13443/base'
    );
    expect(replaceAddressPort('https://hub.example.com:13443/base', null)).toBe(
      'https://hub.example.com/base'
    );
    expect(replaceAddressPort('hub.example.com', 8443)).toBe('hub.example.com:8443');
    expect(replaceAddressPort('https://[2001:db8::1]:9443', 2053)).toBe(
      'https://[2001:db8::1]:2053'
    );
  });

  test('大小写与尾斜杠都不动，只有端口变了', () => {
    expect(replaceAddressPort('HTTPS://Hub.Example.COM/', 8443)).toBe(
      'HTTPS://Hub.Example.COM:8443/'
    );
  });

  test('拆不开的地址原样返回', () => {
    expect(replaceAddressPort('', 8443)).toBe('');
    expect(replaceAddressPort('   ', 8443)).toBe('   ');
    expect(splitAddress('/nothing')).toBeNull();
  });
});

describe('readAddressPort / shouldProbeAddress', () => {
  test('端口读得出来，没写就是 null', () => {
    expect(readAddressPort('https://hub.example.com:13443')).toBe(13443);
    expect(readAddressPort('https://hub.example.com')).toBeNull();
  });

  test('只有「拆得开、没写端口、非回环」的地址才探', () => {
    expect(shouldProbeAddress('https://hub.example.com')).toBe(true);
    expect(shouldProbeAddress('hub.example.com')).toBe(true);
    expect(shouldProbeAddress('https://hub.example.com:13443')).toBe(false);
    expect(shouldProbeAddress('http://127.0.0.1')).toBe(false);
    expect(shouldProbeAddress('http://localhost')).toBe(false);
    expect(shouldProbeAddress('')).toBe(false);
  });
});

const RESOLVED: AddressProbeOutcome = { url: 'https://hub.example.com:13443', probed: true };

describe('createAddressProbeCore', () => {
  test('探到非默认端口：状态给出端口，并把带端口的地址交回调用方', async () => {
    const core = createAddressProbeCore();
    const gate = deferred<AddressProbeOutcome>();
    const pending = core.run('https://hub.example.com', () => gate.promise);
    expect(core.getState()).toEqual({ phase: 'probing', port: null });
    gate.resolve(RESOLVED);
    expect(await pending).toBe('https://hub.example.com:13443');
    expect(core.getState()).toEqual({ phase: 'resolved', port: 13443 });
  });

  test('443 直接通：地址不用改，界面保持沉默', async () => {
    const core = createAddressProbeCore();
    const resolved = await core.run('https://hub.example.com', async () => ({
      url: 'https://hub.example.com',
      probed: true,
    }));
    expect(resolved).toBeNull();
    expect(core.getState().phase).toBe('idle');
  });

  test('一个端口都没答话：失败态', async () => {
    const core = createAddressProbeCore();
    await core.run('https://hub.example.com', async () => ({ url: null, probed: true }));
    expect(core.getState().phase).toBe('failed');
  });

  test('探测抛错也算失败，不把异常抛给表单', async () => {
    const core = createAddressProbeCore();
    await core.run('https://hub.example.com', () => Promise.reject(new Error('boom')));
    expect(core.getState().phase).toBe('failed');
  });

  test('旧网关不给探测结论：保持沉默，不误报失败', async () => {
    const core = createAddressProbeCore();
    const resolved = await core.run('https://hub.example.com', async () => ({
      url: null,
      probed: false,
    }));
    expect(resolved).toBeNull();
    expect(core.getState().phase).toBe('idle');
  });

  test('显式端口不探，状态回到 idle', async () => {
    const core = createAddressProbeCore();
    let called = 0;
    const resolved = await core.run('https://hub.example.com:13443', async () => {
      called += 1;
      return RESOLVED;
    });
    expect(called).toBe(0);
    expect(resolved).toBeNull();
    expect(core.getState().phase).toBe('idle');
  });

  test('探测期间地址被改：迟到的结果既不改状态也不回填地址', async () => {
    const core = createAddressProbeCore();
    const gate = deferred<AddressProbeOutcome>();
    const pending = core.run('https://hub.example.com', () => gate.promise);
    core.reset();
    gate.resolve(RESOLVED);
    expect(await pending).toBeNull();
    expect(core.getState()).toEqual({ phase: 'idle', port: null });
  });

  test('两次探测叠在一起：只认最后一次的结论', async () => {
    const core = createAddressProbeCore();
    const first = deferred<AddressProbeOutcome>();
    const second = deferred<AddressProbeOutcome>();
    const slow = core.run('https://hub.example.com', () => first.promise);
    const fast = core.run('https://other.example.com', () => second.promise);
    second.resolve({ url: 'https://other.example.com:8443', probed: true });
    expect(await fast).toBe('https://other.example.com:8443');
    first.resolve(RESOLVED);
    expect(await slow).toBeNull();
    expect(core.getState()).toEqual({ phase: 'resolved', port: 8443 });
  });
});

describe('precheckProbe', () => {
  test('后端探到端口时交出带端口的地址，并如实带上服务形态', async () => {
    const bodies: unknown[] = [];
    const client = new ApiClient('', async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        reachable: true,
        isSelf: false,
        status: 200,
        error: null,
        resolvedUrl: 'https://hub.example.com:13443',
        triedPorts: [443, 13443],
        probed: true,
      });
    });
    expect(await precheckProbe(client, 'hub')('https://hub.example.com')).toEqual({
      url: 'https://hub.example.com:13443',
      probed: true,
    });
    expect(bodies).toEqual([{ url: 'https://hub.example.com', kind: 'hub' }]);
  });

  test('中继探测按中继判据发问，没探测过的响应一律当作无结论', async () => {
    const client = new ApiClient('', async () =>
      Response.json({ reachable: false, isSelf: false, status: null, error: 'x' })
    );
    expect(await precheckProbe(client, 'relay')('https://relay.example.com')).toEqual({
      url: null,
      probed: false,
    });
  });
});
