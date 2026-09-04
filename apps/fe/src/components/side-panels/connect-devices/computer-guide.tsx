// 「服务器或电脑」页：先选接入方式（经中继 / 经 Hub / SSH 直连），再按所选路径给分步指引。
// 默认选中的路径由本机现状推导，用户改过之后就以他的选择为准。
// 每条路径的步骤自成一套编号：一级选择永远是第 1 步。

import { IconTooltip } from '@tmex/ui/icon-tooltip';
import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JoinSteps } from './computer-join-guide';
import {
  type ConnectPath,
  type ConnectSide,
  defaultConnectPath,
  defaultConnectSide,
} from './connect-path';
import { GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';
import { HostSteps } from './hub-host-steps';
import { InstallStep } from './install-step';
import { RelayHostSteps } from './relay-host-steps';
import { SshSteps } from './ssh-steps';
import { type ConnectMachine, useConnectMachine } from './use-connect-machine';

const PREFIX = 'connectDevices.computer';
const PATHS: ConnectPath[] = ['relay', 'hub', 'ssh'];
/** 选择接入方式固定占第 1 步，需要装 tmex 的路径把安装排在第 2 步。 */
const INSTALL_STEP_INDEX = 2;

function PathHints() {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1">
      {PATHS.map((path) => (
        <li
          key={path}
          className="flex items-start gap-1 text-xs text-muted-foreground"
          data-testid={`connect-path-hint-${path}`}
        >
          <span className="min-w-0">{t(`${PREFIX}.path.hint.${path}`)}</span>
          <IconTooltip label={t(`${PREFIX}.path.tip.${path}`)} side="top" className="mt-0.5">
            <Info className="size-3.5 text-muted-foreground/70" />
          </IconTooltip>
        </li>
      ))}
    </ul>
  );
}

function PathChoiceStep() {
  const { t } = useTranslation();
  return (
    <GuideStep index={1} testId="connect-step-path" title={t(`${PREFIX}.path.title`)}>
      <GuideTabList
        fullWidth
        options={PATHS.map((value) => ({
          value,
          label: t(`${PREFIX}.path.${value}`),
          testId: `connect-path-${value}`,
        }))}
      />
      <PathHints />
    </GuideStep>
  );
}

/** 二级选择：加入现成的上级，还是先把本机搭成上级。 */
function SideTabs({
  path,
  side,
  onSide,
  children,
}: {
  path: 'relay' | 'hub';
  side: ConnectSide;
  onSide: (next: ConnectSide) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const sides: ConnectSide[] = ['join', 'host'];
  return (
    <Tabs className="gap-2" value={side} onValueChange={(next) => onSide(next as ConnectSide)}>
      <GuideTabList
        variant="line"
        options={sides.map((value) => ({
          value,
          label: t(`${PREFIX}.side.${path}.${value}`),
          testId: `connect-side-${path}-${value}`,
        }))}
      />
      {children}
    </Tabs>
  );
}

export function RelayPath({ machine }: { machine: ConnectMachine }) {
  const [chosen, setChosen] = useState<ConnectSide | null>(null);
  const side = chosen ?? defaultConnectSide('relay', machine);
  return (
    <SideTabs path="relay" side={side} onSide={setChosen}>
      <TabsContent value="join" className="space-y-2">
        <InstallStep index={INSTALL_STEP_INDEX} />
        <JoinSteps variant="relay" machine={machine} />
      </TabsContent>
      <TabsContent value="host" className="space-y-2">
        <RelayHostSteps machine={machine} onSwitchToJoin={() => setChosen('join')} />
      </TabsContent>
    </SideTabs>
  );
}

export function HubPath({ machine }: { machine: ConnectMachine }) {
  const [chosen, setChosen] = useState<ConnectSide | null>(null);
  const side = chosen ?? defaultConnectSide('hub', machine);
  return (
    <SideTabs path="hub" side={side} onSide={setChosen}>
      <TabsContent value="join" className="space-y-2">
        <InstallStep index={INSTALL_STEP_INDEX} />
        <JoinSteps variant="hub" machine={machine} />
      </TabsContent>
      <TabsContent value="host" className="space-y-2">
        <HostSteps onSwitchToJoin={() => setChosen('join')} />
      </TabsContent>
    </SideTabs>
  );
}

export function ComputerGuide() {
  const { t } = useTranslation();
  const machine = useConnectMachine();
  const [chosen, setChosen] = useState<ConnectPath | null>(null);
  const path = chosen ?? defaultConnectPath(machine);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t(`${PREFIX}.intro`)}</p>
      <Tabs
        className="gap-2"
        value={path}
        onValueChange={(next) => setChosen(next as ConnectPath)}
        data-testid="connect-computer-paths"
      >
        <PathChoiceStep />
        <TabsContent value="relay" className="space-y-2">
          <RelayPath machine={machine} />
        </TabsContent>
        <TabsContent value="hub" className="space-y-2">
          <HubPath machine={machine} />
        </TabsContent>
        <TabsContent value="ssh" className="space-y-2">
          <SshSteps />
        </TabsContent>
      </Tabs>
    </div>
  );
}
