import { CapturedState, Html2FigmaConfig, StateOperation, StatePath } from "../types.js";
import { startInteractiveCapture, InteractiveCapture } from "../capture/capture.js";
import { StateStore } from "../capture/stateStore.js";
import { shortHash } from "../utils/hash.js";
import { LiveCaptureEvent, liveCaptureBridgeScript, shouldRecordEvent } from "./liveCaptureBridge.js";

export type LiveCaptureSessionStatus = {
  state: "idle" | "recording" | "stopping" | "error";
  message: string;
  recordedStateIds: string[];
};

export class LiveCaptureSession {
  private runtime?: InteractiveCapture;
  private queue = Promise.resolve();
  private sequence = 0;
  private readonly store = new StateStore();
  private current: LiveCaptureSessionStatus = { state: "idle", message: "补录尚未开始。", recordedStateIds: [] };

  constructor(private readonly config: Html2FigmaConfig, private readonly outDir: string, private readonly initialStates: CapturedState[]) {
    for (const state of initialStates) this.store.add(state);
  }

  status(): LiveCaptureSessionStatus {
    return { ...this.current, recordedStateIds: [...this.current.recordedStateIds] };
  }

  async start(headed = true): Promise<LiveCaptureSessionStatus> {
    if (this.runtime) return this.status();
    this.current = { state: "recording", message: "补录窗口已打开，请直接操作原型。", recordedStateIds: [] };
    try {
      this.runtime = await startInteractiveCapture(this.config, { outDir: this.outDir, headed, staticPort: 4173 });
      await this.runtime.page.exposeBinding("__html2figmaRecordEvent", async (_source, event: LiveCaptureEvent) => this.enqueue(event));
      await this.runtime.page.addInitScript({ content: liveCaptureBridgeScript });
      await this.runtime.page.reload({ waitUntil: "domcontentloaded" });
      return this.status();
    } catch (error) {
      this.current = { state: "error", message: error instanceof Error ? error.message : String(error), recordedStateIds: [] };
      throw error;
    }
  }

  async snapshot(): Promise<void> {
    await this.enqueue({ kind: "snapshot", label: "保存当前状态", selector: "body", at: new Date().toISOString() });
  }

  rename(id: string, displayName: string): boolean { return this.store.rename(id, displayName); }
  remove(id: string): boolean { return this.store.remove(id); }
  states(): CapturedState[] { return this.store.states(); }
  coverage() { return this.store.reportCoverage(); }

  async finish(): Promise<CapturedState[]> {
    this.current = { ...this.current, state: "stopping", message: "正在保存补录状态…" };
    await this.queue;
    await this.runtime?.close();
    this.runtime = undefined;
    this.current = { state: "idle", message: "补录已结束，可导入 Figma。", recordedStateIds: this.current.recordedStateIds };
    return this.store.states();
  }

  async close(): Promise<void> { await this.runtime?.close(); this.runtime = undefined; }

  private enqueue(event: LiveCaptureEvent): Promise<void> {
    if (!shouldRecordEvent(event) || !this.runtime) return Promise.resolve();
    this.queue = this.queue.then(async () => {
      const runtime = this.runtime;
      if (!runtime) return;
      await runtime.waitForSettled();
      const kind: StateOperation["kind"] =
        event.kind === "change" ? "select" : event.kind === "scroll" ? "snapshot" : event.kind;
      const operation: StateOperation = {
        kind,
        label: event.label,
        selector: event.selector,
        value: event.inputType === "password" ? undefined : event.value,
        url: event.url,
        at: event.at,
      };
      const stateId = `recorded-${++this.sequence}-${shortHash(`${event.url}:${event.at}`)}`;
      const path: StatePath = { id: `path-${stateId}`, origin: "recorded", operations: [operation], capturedAt: new Date().toISOString() };
      const captured = await runtime.captureCurrent(stateId);
      captured.origin = "recorded";
      captured.displayName = event.label || stateId;
      captured.paths = [path];
      const result = this.store.add(captured);
      if (result.kind === "added") this.current.recordedStateIds.push(result.state.id);
    }).catch((error) => {
      this.current = { ...this.current, state: "error", message: error instanceof Error ? error.message : String(error) };
    });
    return this.queue;
  }
}
