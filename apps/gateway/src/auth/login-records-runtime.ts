import { getShareService } from '../share';
import { getLoginRecordService } from './login-records-service';

export function startGatewaySweepers(): void {
  getShareService().startSweeper();
  getLoginRecordService().startSweeper();
}

export async function stopGatewaySweepers(): Promise<void> {
  getLoginRecordService().stop();
  await getShareService().stop();
}
