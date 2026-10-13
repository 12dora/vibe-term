import { describe, expect, test } from 'bun:test';
import { hasMultipleNodes, pathBasename, tabLabel, tabTitle } from './tab-label';

describe('pathBasename', () => {
  test('returns the last segment', () => {
    expect(pathBasename('/home/alice/projects')).toBe('projects');
    expect(pathBasename('/home')).toBe('home');
  });

  test('ignores trailing slashes', () => {
    expect(pathBasename('/home/alice/')).toBe('alice');
    expect(pathBasename('/home/alice///')).toBe('alice');
  });

  test('root and empty paths fall back to a slash', () => {
    expect(pathBasename('/')).toBe('/');
    expect(pathBasename('')).toBe('/');
  });
});

describe('tabLabel', () => {
  const root = { path: '/srv/data', name: 'Data' };

  test('uses the root name at the root path', () => {
    expect(tabLabel('/srv/data', root)).toBe('Data');
    expect(tabLabel('/srv/data/', root)).toBe('Data');
  });

  test('uses the basename below the root', () => {
    expect(tabLabel('/srv/data/reports', root)).toBe('reports');
  });

  test('falls back to the basename when the root is unknown', () => {
    expect(tabLabel('/srv/data', null)).toBe('data');
    expect(tabLabel('/', undefined)).toBe('/');
  });

  test('falls back to the basename when the root has no name', () => {
    expect(tabLabel('/srv/data', { path: '/srv/data', name: '' })).toBe('data');
  });

  test('filesystem root keeps its display name', () => {
    expect(tabLabel('/', { path: '/', name: '/' })).toBe('/');
  });
});

describe('tabTitle', () => {
  test('joins node name and path', () => {
    expect(tabTitle('alpha', '/srv/data')).toBe('alpha · /srv/data');
  });

  test('omits an unknown node name', () => {
    expect(tabTitle(undefined, '/srv/data')).toBe('/srv/data');
    expect(tabTitle('', '/srv/data')).toBe('/srv/data');
  });
});

describe('hasMultipleNodes', () => {
  test('false for zero or one node', () => {
    expect(hasMultipleNodes([])).toBe(false);
    expect(hasMultipleNodes([{ nodeId: 'self' }, { nodeId: 'self' }])).toBe(false);
  });

  test('true when tabs span nodes', () => {
    expect(hasMultipleNodes([{ nodeId: 'self' }, { nodeId: 'abc' }])).toBe(true);
  });
});
