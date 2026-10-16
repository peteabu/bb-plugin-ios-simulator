import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Device {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
}

export function DevicePicker({ devices, attached, value, onChange, disabled = false, children }: {
  devices: Device[];
  attached: string[];
  value: string | null;
  onChange(udid: string): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const listId = `${id}-devices`;
  const valueId = `${id}-value`;
  const root = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(value);
  const groups = [
    { label: "Attached to thread", devices: devices.filter((device) => attached.includes(device.udid)) },
    { label: "Available", devices: devices.filter((device) => !attached.includes(device.udid)) },
  ].filter((group) => group.devices.length > 0);
  const ordered = groups.flatMap((group) => group.devices);
  const enabled = ordered.filter((device) => device.isAvailable);
  const selected = devices.find((device) => device.udid === value);
  const activeIndex = ordered.findIndex((device) => device.udid === active);
  const optionId = (udid: string) => `${listId}-${ordered.findIndex((device) => device.udid === udid)}`;

  useEffect(() => { setOpen(false); setActive(value); search.current.text = ""; }, [value, disabled]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!enabled.some((device) => device.udid === active)) {
      setActive(enabled.find((device) => device.udid === value)?.udid ?? enabled[0]?.udid ?? null);
      return;
    }
    document.getElementById(optionId(active!))?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, devices, attached, value]);

  const reveal = () => {
    search.current.text = "";
    setActive(enabled.find((device) => device.udid === value)?.udid ?? enabled[0]?.udid ?? null);
    setOpen(true);
  };
  const choose = (udid: string | null) => {
    setOpen(false);
    search.current.text = "";
    if (udid && enabled.some((device) => device.udid === udid) && udid !== value) onChange(udid);
  };
  const typeahead = (character: string) => {
    const now = Date.now();
    const text = `${now - search.current.at < 700 ? search.current.text : ""}${character.toLocaleLowerCase()}`;
    search.current = { text, at: now };
    const query = [...text].every((letter) => letter === text[0]) ? text[0]! : text;
    const current = enabled.findIndex((device) => device.udid === active);
    const start = query.length === 1 ? current + 1 : Math.max(0, current);
    const candidates = [...enabled.slice(start), ...enabled.slice(0, start)];
    const match = candidates.find((device) => device.name.toLocaleLowerCase().startsWith(query));
    setOpen(true);
    if (match) setActive(match.udid);
  };

  return <div ref={root} className="device-picker relative min-w-0 flex-1">
    <Button type="button" variant="ghost" role="combobox" aria-label="Simulator device" aria-describedby={valueId}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? optionId(active!) : undefined}
      disabled={disabled} className="device-picker-trigger h-auto min-h-10 w-full justify-start gap-2 rounded-lg px-1 py-0 text-left"
      onClick={() => { if (open) setOpen(false); else reveal(); }}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !root.current?.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); search.current.text = "";
        } else if (event.key === "Tab") {
          if (open) choose(active);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); search.current.text = "";
          if (!open) reveal();
          else {
            const current = enabled.findIndex((device) => device.udid === active);
            const next = Math.max(0, Math.min(enabled.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
            setActive(enabled[next]?.udid ?? null);
          }
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault(); search.current.text = ""; setOpen(true);
          setActive((event.key === "Home" ? enabled[0] : enabled.at(-1))?.udid ?? null);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (event.key === " " && search.current.text && Date.now() - search.current.at < 700) typeahead(" ");
          else if (open) choose(active);
          else reveal();
        } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault(); typeahead(event.key);
        }
      }}>
      {children}
    </Button>
    <span id={valueId} className="sr-only">{selected ? `${selected.name}, ${selected.runtime}, ${selected.state === "Booted" ? "Running" : selected.state}` : "Choose a simulator"}</span>
    {open ? <div id={listId} role="listbox" aria-label="Simulator devices"
      className="device-picker-popup absolute left-0 top-[calc(100%+6px)] z-50 max-h-[min(320px,calc(100cqh_-_80px))] w-80 max-w-[calc(100cqw_-_24px)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-background p-1.5 shadow-xl">
      {groups.map((group, index) => <div key={group.label} role="group" aria-label={group.label} className={index > 0 ? "mt-1 border-t border-border/60 pt-1" : undefined}>
        <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">{group.label}</p>
        {group.devices.map((device) => <div id={optionId(device.udid)} key={device.udid} role="option" aria-selected={device.udid === value}
          aria-disabled={!device.isAvailable || undefined} aria-label={`${device.name}, ${device.runtime}${device.state === "Booted" ? ", Running" : ""}${!device.isAvailable ? ", Unavailable" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => { if (device.isAvailable) setActive(device.udid); }}
          onClick={() => { if (device.isAvailable) choose(device.udid); }}
          className={`device-picker-option flex min-h-12 items-center gap-3 rounded-md px-2.5 py-2 text-left transition-[background-color,color] duration-150 motion-reduce:transition-none ${!device.isAvailable ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-state-hover"} ${device.udid === active && device.isAvailable ? "bg-state-active text-foreground" : ""}`}>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2"><span className="truncate text-xs font-medium">{device.name}</span>
              {device.state === "Booted" ? <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"><span className="size-1 rounded-full bg-emerald-500" />Running</span> : null}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{device.runtime}{!device.isAvailable ? " · Unavailable" : ""}</p>
          </div>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" className={`size-4 shrink-0 ${device.udid === value ? "opacity-100" : "opacity-0"}`}><path d="m4 10 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>)}
      </div>)}
      {!ordered.length ? <p className="px-3 py-5 text-xs text-muted-foreground">No simulators available</p> : null}
    </div> : null}
  </div>;
}
