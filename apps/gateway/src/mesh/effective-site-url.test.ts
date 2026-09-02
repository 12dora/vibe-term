import { describe, expect, test } from 'bun:test';
import {
  createMeshSiteSettingsLink,
  nodeAccessUrl,
  resolveMeshHubPublicUrl,
} from './effective-site-url';

const WRITER = 'aa'.repeat(16);
const STANDBY = 'bb'.repeat(16);
const NODE = 'cc'.repeat(16);

function hubStore(
  rows: Array<{
    hubNodeId: string;
    publicUrl: string;
    mode: 'active' | 'standby';
    writerEpoch: number;
    priority: number;
  }>
) {
  const map = new Map(rows.map((row) => [row.hubNodeId, row]));
  return {
    list: () => rows,
    get: (id: string) => map.get(id) ?? null,
  };
}

describe('resolveMeshHubPublicUrl', () => {
  test('prefers writer publicUrl, then attached, then config, then meta', () => {
    expect(
      resolveMeshHubPublicUrl({
        hubStore: hubStore([
          {
            hubNodeId: WRITER,
            publicUrl: 'https://writer.example',
            mode: 'active',
            writerEpoch: 3,
            priority: 1,
          },
          {
            hubNodeId: STANDBY,
            publicUrl: 'https://standby.example',
            mode: 'standby',
            writerEpoch: 1,
            priority: 9,
          },
        ]),
        attachedPublicUrl: 'https://attached.example',
        hubPublicUrl: 'https://config.example',
        hubMetaPublicUrl: 'https://meta.example',
      })
    ).toBe('https://writer.example');

    expect(
      resolveMeshHubPublicUrl({
        hubStore: hubStore([]),
        attachedPublicUrl: 'https://attached.example',
        hubPublicUrl: 'https://config.example',
      })
    ).toBe('https://attached.example');

    expect(
      resolveMeshHubPublicUrl({
        hubStore: null,
        attachedPublicUrl: null,
        hubPublicUrl: 'https://config.example',
        hubMetaPublicUrl: 'https://meta.example',
      })
    ).toBe('https://config.example');

    expect(
      resolveMeshHubPublicUrl({
        hubStore: null,
        attachedPublicUrl: null,
        hubPublicUrl: null,
        hubMetaPublicUrl: 'https://meta.example',
      })
    ).toBe('https://meta.example');
  });
});

describe('createMeshSiteSettingsLink', () => {
  test('hub role uses hub public URL; pure node uses /n/<id>', () => {
    const store = hubStore([
      {
        hubNodeId: WRITER,
        publicUrl: 'https://hub.example/',
        mode: 'active',
        writerEpoch: 1,
        priority: 1,
      },
    ]);
    const hubLink = createMeshSiteSettingsLink({
      roles: { hub: true, node: true },
      localNodeId: () => WRITER,
      hubStore: store,
      attachedHub: () => ({ publicUrl: 'https://attached.example' }),
      hubPublicUrl: 'https://config.example',
    });
    expect(hubLink.linked()).toBe(true);
    expect(hubLink.localNodeId()).toBe(WRITER);
    expect(hubLink.effectiveSiteUrl()).toBe('https://hub.example/');

    const nodeLink = createMeshSiteSettingsLink({
      roles: { hub: false, node: true },
      localNodeId: () => NODE,
      hubStore: store,
      attachedHub: () => ({ publicUrl: 'https://attached.example' }),
      hubPublicUrl: 'https://config.example',
    });
    expect(nodeLink.effectiveSiteUrl()).toBe(nodeAccessUrl('https://hub.example/', NODE));
    expect(nodeLink.effectiveSiteUrl()).toBe(`https://hub.example/n/${NODE}`);
  });

  test('pure node returns null when hub URL is unknown so callers fall back to stored site_url', () => {
    const nodeLink = createMeshSiteSettingsLink({
      roles: { hub: false, node: true },
      localNodeId: () => NODE,
      hubStore: null,
      attachedHub: () => null,
      hubPublicUrl: null,
    });
    expect(nodeLink.linked()).toBe(true);
    expect(nodeLink.effectiveSiteUrl()).toBeNull();
  });

  test('standalone flags are unlinked', () => {
    const link = createMeshSiteSettingsLink({
      roles: { hub: false, node: false },
      localNodeId: () => NODE,
      hubStore: null,
      attachedHub: () => ({ publicUrl: 'https://hub.example' }),
      hubPublicUrl: 'https://config.example',
    });
    expect(link.linked()).toBe(false);
    expect(link.localNodeId()).toBeNull();
    expect(link.effectiveSiteUrl()).toBeNull();
  });

  test('standby hub without own public URL uses writer URL /n/<self>', () => {
    const store = hubStore([
      {
        hubNodeId: WRITER,
        publicUrl: 'https://a.example',
        mode: 'active',
        writerEpoch: 2,
        priority: 1,
      },
      {
        hubNodeId: STANDBY,
        publicUrl: '',
        mode: 'standby',
        writerEpoch: 1,
        priority: 9,
      },
    ]);
    const standby = createMeshSiteSettingsLink({
      roles: { hub: true, node: true },
      localNodeId: () => STANDBY,
      hubStore: store,
      attachedHub: () => null,
      hubPublicUrl: null,
    });
    expect(standby.effectiveSiteUrl()).toBe(`https://a.example/n/${STANDBY}`);
  });

  test('standby hub with own hub record publicUrl uses that root URL', () => {
    const store = hubStore([
      {
        hubNodeId: WRITER,
        publicUrl: 'https://a.example',
        mode: 'active',
        writerEpoch: 2,
        priority: 1,
      },
      {
        hubNodeId: STANDBY,
        publicUrl: 'https://b.example',
        mode: 'standby',
        writerEpoch: 1,
        priority: 9,
      },
    ]);
    const standby = createMeshSiteSettingsLink({
      roles: { hub: true, node: true },
      localNodeId: () => STANDBY,
      hubStore: store,
      attachedHub: () => null,
      hubPublicUrl: null,
    });
    expect(standby.effectiveSiteUrl()).toBe('https://b.example');
  });

  test('standby hub with own hubPublicUrl uses that root URL', () => {
    const store = hubStore([
      {
        hubNodeId: WRITER,
        publicUrl: 'https://a.example',
        mode: 'active',
        writerEpoch: 2,
        priority: 1,
      },
      {
        hubNodeId: STANDBY,
        publicUrl: '',
        mode: 'standby',
        writerEpoch: 1,
        priority: 9,
      },
    ]);
    const standby = createMeshSiteSettingsLink({
      roles: { hub: true, node: true },
      localNodeId: () => STANDBY,
      hubStore: store,
      attachedHub: () => null,
      hubPublicUrl: 'https://b.example',
    });
    expect(standby.effectiveSiteUrl()).toBe('https://b.example');
  });

  test('self as writer uses the hub root URL', () => {
    const store = hubStore([
      {
        hubNodeId: WRITER,
        publicUrl: 'https://a.example',
        mode: 'active',
        writerEpoch: 2,
        priority: 1,
      },
      {
        hubNodeId: STANDBY,
        publicUrl: 'https://b.example',
        mode: 'standby',
        writerEpoch: 1,
        priority: 9,
      },
    ]);
    const writer = createMeshSiteSettingsLink({
      roles: { hub: true, node: true },
      localNodeId: () => WRITER,
      hubStore: store,
      attachedHub: () => null,
      hubPublicUrl: null,
    });
    expect(writer.effectiveSiteUrl()).toBe('https://a.example');
  });
});
