import { eventNotifier } from '../events';
import { type DeviceSessionRuntime, createDeviceSessionRuntime } from './device-session-runtime';
import { createTmuxRuntimeRegistry } from './runtime-registry';

export const tmuxRuntimeRegistry = createTmuxRuntimeRegistry<DeviceSessionRuntime>({
  async createRuntime(deviceId) {
    return createDeviceSessionRuntime({
      deviceId,
      notifyEvent: (eventType, event) => {
        void eventNotifier.notify(eventType, event);
      },
    });
  },
});
