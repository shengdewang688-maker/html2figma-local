export type LiveEventKind = "click" | "input" | "change" | "submit" | "key" | "route" | "snapshot" | "scroll";

export type LiveCaptureEvent = {
  kind: LiveEventKind;
  label?: string;
  selector?: string;
  inputType?: string;
  value?: string;
  url?: string;
  at: string;
};

export function shouldRecordEvent(event: Pick<LiveCaptureEvent, "kind" | "inputType">): boolean {
  return event.kind !== "scroll";
}

export function isRecordingControl(target: Pick<Element, "closest"> | null): boolean {
  return Boolean(target?.closest("[data-html2figma-capture-control]"));
}

// Do not pass a TypeScript function to Playwright: tsx may serialize helper names into it.
export const liveCaptureBridgeScript = String.raw`(() => {
  const info = (element) => {
    if (!element) return { label: 'page', selector: 'body' };
    const label = element.getAttribute('data-testid') || element.id || element.getAttribute('name') || element.getAttribute('aria-label') || element.getAttribute('role') || (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80) || element.tagName.toLowerCase();
    return { label, selector: element.id ? '#' + CSS.escape(element.id) : element.tagName.toLowerCase() };
  };
  window.__html2figmaSaveSnapshot = () => {
    const event = Object.assign({ kind: 'snapshot' }, info(document.body), { url: location.href, at: new Date().toISOString() });
    return window.__html2figmaRecordEvent ? window.__html2figmaRecordEvent(event) : Promise.reject(new Error('补录连接尚未就绪'));
  };
})();`;
