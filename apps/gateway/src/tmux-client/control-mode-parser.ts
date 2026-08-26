import { createLineFramer } from './control-mode/framing';
import {
  createNotificationParseState,
  dispatchControlModeLine,
} from './control-mode/notifications';
import type {
  ControlModeBlock,
  ControlModeNotification,
  ControlModeParser,
  ControlModeParserCallbacks,
} from './control-mode/types';
import { unescapeControlModeData } from './control-mode/unescape';

export type {
  ControlModeBlock,
  ControlModeNotification,
  ControlModeParser,
  ControlModeParserCallbacks,
};
export { unescapeControlModeData };

export function createControlModeParser(callbacks: ControlModeParserCallbacks): ControlModeParser {
  const state = createNotificationParseState();
  return createLineFramer((line) => {
    dispatchControlModeLine(callbacks, state, line);
  });
}
