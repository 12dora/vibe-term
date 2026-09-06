import { LlmProvidersTab } from '@vibeterm/panels/settings/llm-providers';
import { SearchTab } from '@vibeterm/panels/settings/search';

export function AISettingsTab() {
  return (
    <>
      <LlmProvidersTab />
      <SearchTab />
    </>
  );
}
