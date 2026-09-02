import { Button } from '@tmex/ui/button';
import { Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SettingsSaveButtonProps {
  onSave: () => void;
  isSaving: boolean;
  /** 没有实际改动时锁住（「通用」标签用）；缺省一直可点。 */
  disabled?: boolean;
}

// 保存按钮置于各自作用范围的卡片内（站点信息卡 / 通知卡），不再悬于卡片外
export function SettingsSaveButton({ onSave, isSaving, disabled }: SettingsSaveButtonProps) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-end pt-2">
      <Button
        variant="secondary"
        data-testid="settings-save"
        onClick={onSave}
        disabled={isSaving || disabled === true}
        className="w-full sm:w-auto"
      >
        <Save className="h-4 w-4" />
        {t('common.save')}
      </Button>
    </div>
  );
}
