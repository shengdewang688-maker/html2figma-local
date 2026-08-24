import { CandidateOutcome, CapturedState, StateCoverage, StatePath } from "../types.js";

export type StateAddResult = {
  kind: "added" | "duplicate";
  state: CapturedState;
};

/** Keeps unique visual states and every route by which the state was reached. */
export class StateStore {
  private readonly capturedStates: CapturedState[] = [];
  private readonly outcomes: CandidateOutcome[] = [];
  private duplicateCount = 0;

  add(incoming: CapturedState): StateAddResult {
    const existing = this.capturedStates.find((state) => this.samePage(state, incoming));
    if (existing) {
      existing.paths = [...(existing.paths ?? []), ...copyPaths(incoming.paths ?? [])];
      if (incoming.origin === "recorded" && incoming.displayName) {
        existing.displayName = incoming.displayName;
      }
      this.duplicateCount += 1;
      return { kind: "duplicate", state: copyState(existing) };
    }

    const state = copyState(incoming);
    this.capturedStates.push(state);
    return { kind: "added", state: copyState(state) };
  }

  recordOutcome(outcome: CandidateOutcome): void {
    this.outcomes.push({ ...outcome });
  }

  states(): CapturedState[] {
    return this.capturedStates.map(copyState);
  }

  pathsFor(id: string): StatePath[] {
    const state = this.capturedStates.find((entry) => entry.id === id);
    return copyPaths(state?.paths ?? []);
  }

  rename(id: string, name: string): boolean {
    const state = this.capturedStates.find((entry) => entry.id === id);
    if (!state) return false;
    state.displayName = name;
    return true;
  }

  remove(id: string): boolean {
    const index = this.capturedStates.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.capturedStates.splice(index, 1);
    return true;
  }

  reportCoverage(): StateCoverage {
    return {
      captured: this.capturedStates.length,
      auto: this.capturedStates.filter((state) => state.origin === "auto").length,
      recorded: this.capturedStates.filter((state) => state.origin === "recorded").length,
      duplicates: this.duplicateCount,
      outcomes: this.outcomes.map((outcome) => ({ ...outcome })),
    };
  }

  private samePage(left: CapturedState, right: CapturedState): boolean {
    const leftHash = left.pageHash || left.domHash;
    const rightHash = right.pageHash || right.domHash;
    return leftHash === rightHash;
  }
}

function copyState(state: CapturedState): CapturedState {
  return {
    ...state,
    paths: copyPaths(state.paths ?? []),
  };
}

function copyPaths(paths: StatePath[]): StatePath[] {
  return paths.map((path) => ({
    ...path,
    operations: path.operations.map((operation) => ({ ...operation })),
  }));
}
