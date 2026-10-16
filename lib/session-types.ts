import type { ScreenConfig } from "./sim-protocol";

export type Driver = "human" | "agent";
export interface ControlState {
  threadId: string;
  mode: Driver;
  changedAt: number;
}
export interface TimelineEvent {
  id: string;
  at: number;
  kind: "input" | "log" | "crash" | "control" | "lifecycle" | "error";
  actor: Driver | "system";
  label: string;
  detail?: string;
  threadId?: string;
}
export interface ReplayClipInfo {
  id: string;
  udid: string;
  threadId: string;
  createdAt: number;
  startAt: number;
  endAt: number;
  frameCount: number;
}
export interface ReplayFrame {
  at: number;
  key: boolean;
  data: string;
  config: ScreenConfig | null;
}
export interface ReplayClip extends ReplayClipInfo {
  description: string;
  frames: ReplayFrame[];
  events: TimelineEvent[];
}
export interface ReplayStatus {
  recording: boolean;
  bufferedMs: number;
  bytes: number;
  error: string | null;
  app: string | null;
  diagnostics: string | null;
  clips: ReplayClipInfo[];
}
