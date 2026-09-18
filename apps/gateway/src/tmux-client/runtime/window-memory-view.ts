import type {
  WindowMemoryListener,
  WindowMemoryRuntimeAdapter,
} from '../../window-memory/runtime-adapter';

export abstract class WindowMemoryRuntimeFacade {
  protected abstract readonly windowMemoryRuntime: WindowMemoryRuntimeAdapter;

  getWindowMemory() {
    return this.windowMemoryRuntime.getWindows();
  }

  getWindowMemorySupported() {
    return this.windowMemoryRuntime.supported();
  }

  getWindowMemoryLimitsSupported() {
    return this.windowMemoryRuntime.limitsSupported();
  }

  onWindowMemory(listener: WindowMemoryListener) {
    return this.windowMemoryRuntime.subscribe(listener);
  }

  tickWindowMemory() {
    return this.windowMemoryRuntime.tick();
  }
}
