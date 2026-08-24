import assert from "node:assert/strict";
import { isRecordingControl, liveCaptureBridgeScript, shouldRecordEvent } from "../dist/src/recording/liveCaptureBridge.js";

assert.equal(shouldRecordEvent({ kind: "scroll" }), false);
assert.equal(shouldRecordEvent({ kind: "input", inputType: "password" }), true);
assert.equal(shouldRecordEvent({ kind: "click" }), true);
assert.equal(isRecordingControl({ closest: (selector) => selector === "[data-html2figma-capture-control]" ? {} : null }), true);
assert.equal(isRecordingControl({ closest: () => null }), false);
assert.match(liveCaptureBridgeScript, /__html2figmaSaveSnapshot/);
assert.match(liveCaptureBridgeScript, /Promise\.reject/);
assert.doesNotMatch(liveCaptureBridgeScript, /document\.addEventListener\('click'/);
console.log("live bridge verified");
