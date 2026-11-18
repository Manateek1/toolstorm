import type { RunRecord } from "../domain/types";

const STORAGE_KEY = "toolstorm.history.v1";
const MAX_SAVED_RUNS = 16;

export function readRunHistory(): RunRecord[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((run): run is RunRecord => Boolean(run && typeof run === "object" && "id" in run && "trace" in run));
  } catch {
    return [];
  }
}

export function saveRunHistory(runs: RunRecord[]) {
  try {
    if (runs.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs.slice(0, MAX_SAVED_RUNS)));
  } catch {
    // Run results remain visible for this session if browser storage is unavailable.
  }
}

export function clearRunHistory() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The clear action still clears in-memory history.
  }
}

export function exportRun(run: RunRecord) {
  const blob = new Blob([JSON.stringify(run, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `toolstorm-ticket-104-${run.id.slice(0, 8)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}
