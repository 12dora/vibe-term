// 设备 IO 队列：transfer 每设备最多 3 路并发；read 与 transfer 互斥于 mutation，
// 但不占 transfer 槽位；mutation 独占该设备。
// mutation 一旦入队，其后任务一律排在它后面（FIFO，避免 writer 饥饿）。
// 全局并发上限限制同时存活的 rsync / ssh 进程数。

export type DeviceJobKind = 'read' | 'transfer' | 'mutation';

export const DEVICE_TRANSFER_CONCURRENCY = 3;
export const GLOBAL_MAX_CONCURRENT = 8;

type DeviceLane = {
  running: number;
  transfersRunning: number;
  mutationRunning: boolean;
  queue: Array<{ kind: DeviceJobKind; start: () => void }>;
};

type JobSettlement<T> = {
  deviceId: string;
  lane: DeviceLane;
  kind: DeviceJobKind;
  job: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

const lanes = new Map<string, DeviceLane>();
let globalActive = 0;
const globalWaiters: Array<() => void> = [];

function laneOf(deviceId: string): DeviceLane {
  let lane = lanes.get(deviceId);
  if (!lane) {
    lane = { running: 0, transfersRunning: 0, mutationRunning: false, queue: [] };
    lanes.set(deviceId, lane);
  }
  return lane;
}

function takeGlobal(run: () => void): void {
  if (globalActive < GLOBAL_MAX_CONCURRENT) {
    globalActive += 1;
    run();
    return;
  }
  globalWaiters.push(run);
}

function releaseGlobal(): void {
  const next = globalWaiters.shift();
  if (next) {
    next();
    return;
  }
  globalActive -= 1;
}

function canDispatch(lane: DeviceLane, kind: DeviceJobKind): boolean {
  if (kind === 'mutation') return lane.running === 0;
  if (lane.mutationRunning) return false;
  if (kind === 'read') return true;
  return lane.transfersRunning < DEVICE_TRANSFER_CONCURRENCY;
}

function pump(lane: DeviceLane): void {
  while (lane.queue.length > 0) {
    const head = lane.queue[0];
    if (!head || !canDispatch(lane, head.kind)) break;
    lane.queue.shift();
    lane.running += 1;
    if (head.kind === 'mutation') lane.mutationRunning = true;
    if (head.kind === 'transfer') lane.transfersRunning += 1;
    head.start();
  }
}

function finish(deviceId: string, lane: DeviceLane, kind: DeviceJobKind): void {
  lane.running -= 1;
  if (kind === 'mutation') lane.mutationRunning = false;
  if (kind === 'transfer') lane.transfersRunning -= 1;
  if (lane.running === 0 && lane.queue.length === 0) {
    lanes.delete(deviceId);
    return;
  }
  pump(lane);
}

async function settleJob<T>(s: JobSettlement<T>): Promise<void> {
  try {
    s.resolve(await s.job());
  } catch (err) {
    s.reject(err);
  } finally {
    releaseGlobal();
    finish(s.deviceId, s.lane, s.kind);
  }
}

export function enqueueDeviceJob<T>(
  deviceId: string,
  kind: DeviceJobKind,
  job: () => Promise<T>
): Promise<T> {
  const lane = laneOf(deviceId);
  return new Promise<T>((resolve, reject) => {
    lane.queue.push({
      kind,
      start: () => {
        takeGlobal(() => {
          void settleJob({ deviceId, lane, kind, job, resolve, reject });
        });
      },
    });
    pump(lane);
  });
}
