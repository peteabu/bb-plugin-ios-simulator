// bb-plugin-ios-simulator — frontend entry.
//
// Three surfaces: the iOS Simulator tab in a thread's side panel, an
// invisible app-wide overlay that opens that tab when an agent attaches a
// device, and the consent form an agent's first control request shows.
import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { DeviceConsentForm } from "@/components/device-consent";
import { SimulatorPanel } from "@/components/simulator-panel";
import { AndroidPanel } from "@/components/android-panel";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export const PANEL_ACTION_ID = "simulator";

function SimulatorWorkspace(props: PluginThreadPanelProps) {
  const requested = props.params && typeof props.params === "object" && !Array.isArray(props.params)
    && props.params.platform === "android" ? "android" : "ios";
  const [platform, setPlatform] = useState<"ios" | "android">(requested);
  useEffect(() => setPlatform(requested), [requested, props.threadId]);
  useRealtime("android-attached", (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === props.threadId) setPlatform("android");
  });
  useRealtime("attached", (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === props.threadId) setPlatform("ios");
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="group" aria-label="Simulator platform" className="flex shrink-0 gap-1 border-b border-border px-3 py-2">
        {(["ios", "android"] as const).map((value) => (
          <Button key={value} size="sm" variant={platform === value ? "secondary" : "ghost"}
            aria-pressed={platform === value} onClick={() => setPlatform(value)}>
            {value === "ios" ? "iOS" : "Android"}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {platform === "ios" ? <SimulatorPanel {...props} /> : <AndroidPanel {...props} />}
      </div>
    </div>
  );
}

function OpenSimulatorPanel() {
  const navigate = useBbNavigate();
  return (
    <span title="Open Simulator" className="inline-flex">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground transition-transform active:scale-[0.96]"
        aria-label="Open Simulator"
        onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
      >
        <Icon name="Smartphone" className="size-4" />
      </Button>
    </span>
  );
}

function AutoOpenSimulatorPanel() {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  useRealtime("attached", (payload) => {
    const signal = payload as { threadId?: unknown } | null;
    if (!signal || typeof signal.threadId !== "string" || signal.threadId !== threadId) return;
    navigate.openThreadPanel({ actionId: PANEL_ACTION_ID });
  });
  useRealtime("android-attached", (payload) => {
    const signal = payload as { threadId?: unknown } | null;
    if (signal?.threadId === threadId) navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, params: { platform: "android" } });
  });
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "open-simulator",
    title: "Simulator",
    component: OpenSimulatorPanel,
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Simulator",
    icon: "Smartphone",
    layout: "flush",
    component: SimulatorWorkspace,
    run: ({ openPanel }) => {
      openPanel();
    },
  });
  app.slots.experimental_appOverlay({
    id: "auto-open-simulator",
    component: AutoOpenSimulatorPanel,
  });
  app.slots.pendingInteraction({
    id: "device-consent",
    component: DeviceConsentForm,
  });
});
