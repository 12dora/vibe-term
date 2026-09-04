import { describe, expect, test } from 'bun:test';
import { createCommandRegistry } from './registry';

describe('createCommandRegistry', () => {
  test('registers, finds by name and alias, and lists', () => {
    const registry = createCommandRegistry();
    registry.register({
      name: 'Status',
      aliases: ['st', 'stat'],
      args: [],
      descriptionKey: 'messaging.command.status.description',
      requires: 'read',
    });
    expect(registry.find('status')?.name).toBe('status');
    expect(registry.find('ST')?.name).toBe('status');
    expect(registry.find('missing')).toBeNull();
    expect(registry.list().map((spec) => spec.name)).toEqual(['status']);
  });
});
