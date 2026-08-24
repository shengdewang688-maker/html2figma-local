# Interaction State Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture meaningful selection-dependent flows once while collapsing equivalent list-item selections.

**Architecture:** Extend state metadata for explicitly retained snapshots, add interaction state to semantic page hashing, and teach discovery to identify and collapse equivalent selection controls. A Playwright-backed fixture verifies the whole CLI capture path.

**Tech Stack:** TypeScript, Playwright, Node.js assertion scripts.

## Global Constraints

- Preserve existing capture behavior for buttons, links, and configured exclusions.
- Keep user-authored uncommitted changes intact.
- Do not add runtime dependencies.

---

### Task 1: Define the regression fixture

**Files:**
- Create: `examples/interaction-states.html`
- Create: `scripts/verify-interaction-states.mjs`
- Modify: `package.json`

- [ ] Write a fixture with two same-group selectable rows, disabled dependent actions, and two distinct follow-up panels.
- [ ] Write a verifier that expects four states (`default`, one selected representative, `cancel`, `reassign`) and fails when the current explorer omits selection controls or captures both rows.
- [ ] Run `npm run verify:interaction-states` and confirm it fails before production changes.

### Task 2: Preserve and distinguish interaction states

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/capture/capture.ts`

- [ ] Add `capture: "always"` to explicit state actions and make it bypass semantic duplicate suppression.
- [ ] Include selected, checked, expanded, and disabled control state in the semantic page signature.
- [ ] Run `npm run verify:interaction-states` and confirm explicit selected states are retained.

### Task 3: Collapse equivalent selection candidates

**Files:**
- Modify: `src/config.ts`
- Modify: `src/capture/capture.ts`
- Modify: `README.md`

- [ ] Add native and ARIA selection controls to default discovery.
- [ ] Derive a selection equivalence key from explicit grouping or semantic control/container identity and explore one candidate per group.
- [ ] Document automatic folding and explicit retention, then run the complete verification suite.
