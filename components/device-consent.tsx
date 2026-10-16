import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** Shown in the composer the first time an agent asks to control a device. */
export function DeviceConsentForm({ interaction, submit }: PluginPendingInteractionProps) {
  const payload = (interaction.payload ?? {}) as { name?: unknown; runtime?: unknown };
  const name = typeof payload.name === "string" ? payload.name : "this simulator";
  const runtime = typeof payload.runtime === "string" ? ` (${payload.runtime})` : "";
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <div className="flex items-start gap-3">
        <Icon name="Smartphone" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Allow the agent to control {name}
            {runtime}?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            It will tap, type, launch apps, and take screenshots on this simulated
            device. Screenshots are sent to the model provider with the
            conversation, so do not sign in to real accounts on it. You decide once
            per device and can change it later in the simulator panel.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void submit({ allow: true })}>
              Allow
            </Button>
            <Button size="sm" variant="outline" onClick={() => void submit({ allow: false })}>
              Don&apos;t allow
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
