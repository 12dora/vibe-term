import { DeviceManagementActions, DeviceManagementPanel } from '@tmex/panels/device-management';
import { useTranslation } from 'react-i18next';

export default function DevicesPage() {
  return <DeviceManagementPanel />;
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.manageDevices')}</>;
}

// Page actions component
export function PageActions() {
  return <DeviceManagementActions />;
}
