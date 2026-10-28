/*
 * The seam between the scene (web/scene/**, the canvas office) and the UI
 * chrome (web/ui/**, web/main.ts: HUD, feed, inspector, toolbar). The UI owns
 * the SSE connection and feeds events in; the scene owns everything drawn on
 * the canvas.
 */
import type { OfficeEvent, Snapshot, WorkerState } from "../src/shared/events.ts";
import type { CityId } from "./cities.ts";

export interface OfficeScene {
  /** Replace the whole office with a snapshot (on connect / reconnect). */
  load(snapshot: Snapshot): void;
  /** Fold one live event in: move, animate, spawn or remove workers. */
  apply(event: OfficeEvent): void;
  /** Move the office: the skyline, sky and wall clock follow that city. */
  setCity?(city: CityId): void;
  getCity?(): CityId;
  /** A still of a city's view right now (art px), for the location picker. */
  previewCity?(city: CityId, w: number, h: number): HTMLCanvasElement;
  /** CRT scanlines + bloom overlay. */
  setCrt(on: boolean): void;
  /** Called when the user clicks a worker (null when clicking empty floor). */
  onSelect(cb: (workerId: string | null) => void): void;
  /** Called when the pointer moves onto a worker (or off one: null), so the chrome can get ready for a click. */
  onHover?(cb: (workerId: string | null) => void): void;
  /** Highlight a worker (from the feed or inspector), null clears. */
  select(workerId: string | null): void;
  /** Pan/zoom the camera so this worker is centred. */
  focus(workerId: string): void;
  /**
   * Keep auto-fit clear of the chrome's panels (CSS px from each edge). `overlay` is for panels
   * that come and go with a selection (the inspector, the phone sheet): the camera frames around
   * them too, but they never re-pack the office, so clicking a worker doesn't rearrange it.
   */
  setInsets?(insets: { top: number; right: number; bottom: number; left: number }, overlay?: Partial<{ top: number; right: number; bottom: number; left: number }>): void;
  /**
   * Director mode (stream mode): the camera cuts in on each big moment (a flip, a shout, a
   * sandbox beaming in) with letterbox bars and a caption, then back out to the whole office.
   */
  setDirector?(on: boolean): void;
  /** The canvas, for PNG export and MediaRecorder capture. */
  readonly canvas: HTMLCanvasElement;
  destroy(): void;
}

/** Implemented in web/scene/index.ts. */
export type CreateOfficeScene = (mount: HTMLElement) => OfficeScene;

export type { OfficeEvent, Snapshot, WorkerState };
