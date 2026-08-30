import { LlmProvidersTab } from '@tmex/panels/settings/llm-providers';
import { SearchTab } from '@tmex/panels/settings/search';

export function AISettingsTab() {
  return (
    <>
      <LlmProvidersTab />
      <SearchTab />
    </>
  );
}
