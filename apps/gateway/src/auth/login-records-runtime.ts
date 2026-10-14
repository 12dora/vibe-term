import { getShareService } from '../share';
import { startAccessTokenLifecycle, stopAccessTokenLifecycle } from './access-token-lifecycle';
import { getLoginRecordService } from './login-records-service';

export function startGatewaySweepers(): void {
  getShareService().startSweeper();
  getLoginRecordService().startSweeper();
  startAccessTokenLifecycle();
}

export async function stopGatewaySweepers(): Promise<void> {
  stopAccessTokenLifecycle();
  getLoginRecordService().stop();
  await getShareService().stop();
}
