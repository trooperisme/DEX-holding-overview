import {
  RefreshLogTone,
  RefreshProgressState,
} from "./types";

export type RefreshCallbacks = {
  onLog?: (tone: RefreshLogTone, message: string) => void;
  onProgress?: (progress: RefreshProgressState) => void;
};

export function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

export function createProgressState(partial: Partial<RefreshProgressState> = {}): RefreshProgressState {
  return {
    snapshotId: null,
    totalEntities: 0,
    entitiesCompleted: 0,
    entitiesFailed: 0,
    totalRows: 0,
    currentEntity: null,
    currentEntityIndex: null,
    status: "running",
    errorMessage: null,
    ...partial,
  };
}

export function emitLog(callbacks: RefreshCallbacks, tone: RefreshLogTone, message: string): void {
  callbacks.onLog?.(tone, message);
}

export function emitProgress(callbacks: RefreshCallbacks, partial: Partial<RefreshProgressState>): void {
  callbacks.onProgress?.(createProgressState(partial));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Refresh canceled", "AbortError");
  }
}
