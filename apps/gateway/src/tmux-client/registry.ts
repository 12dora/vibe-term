import { getDeviceById } from '../db';
import { eventNotifier } from '../events';
import { type DeviceSessionRuntime, createDeviceSessionRuntime } from './device-session-runtime';
import { createTmuxRuntimeRegistry } from './runtime-registry';

export const tmuxRuntimeRegistry = createTmuxRuntimeRegistry<DeviceSessionRuntime>({
  async createRuntime(deviceId) {
    const device = getDeviceById(deviceId);
    return createDeviceSessionRuntime({
      deviceId,
      deviceName: device?.name,
      notifyEvent: (eventType, event) => {
        void eventNotifier.notify(eventType, event);
      },
    });
  },
});
