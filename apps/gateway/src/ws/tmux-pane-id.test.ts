import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { assertTmuxPaneId } from './tmux-pane-id';

describe('assertTmuxPaneId', () => {
  test('合法 pane id 放行', () => {
    expect(() => assertTmuxPaneId('%1')).not.toThrow();
    expect(() => assertTmuxPaneId('%12')).not.toThrow();
  });

  test('注入式 / 非法 pane id 抛 ERROR_TMUX_TARGET_NOT_FOUND', () => {
    for (const paneId of ['%missing', '%1;touch /tmp/x', '%1\n', '1', '', '@1', '%1_bad']) {
      try {
        assertTmuxPaneId(paneId);
        throw new Error(`expected throw for ${paneId}`);
      } catch (err) {
        expect(err).toBeInstanceOf(wsBorsh.WsBorshError);
        expect((err as InstanceType<typeof wsBorsh.WsBorshError>).code).toBe(
          wsBorsh.ERROR_TMUX_TARGET_NOT_FOUND
        );
      }
    }
  });
});
