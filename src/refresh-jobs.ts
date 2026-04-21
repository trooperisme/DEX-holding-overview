import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { runDexRefresh } from "./dex-refresh";
import {
  RefreshJobState,
  RefreshLogEntry,
  RefreshLogTone,
  RefreshProgressState,
  RefreshResult,
} from "./types";

type RefreshJobSnapshot = RefreshJobState & {
  controller: AbortController;
  result: RefreshResult | null;
};

type PublicRefreshJobState = RefreshJobState & {
  result: RefreshResult | null;
};

function createInitialProgress(): RefreshProgressState {
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
  };
}

function cloneJob(job: RefreshJobSnapshot | null): PublicRefreshJobState | null {
  if (!job) return null;
  return {
    jobId: job.jobId,
    running: job.running,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    apiKeyLabel: job.apiKeyLabel,
    progress: { ...job.progress },
    logs: job.logs.map((entry) => ({ ...entry })),
    result: job.result ? { ...job.result } : null,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

export function createRefreshJobManager(cwd: string) {
  let currentJob: RefreshJobSnapshot | null = null;
  let lastJob: PublicRefreshJobState | null = null;

  const appendLog = (tone: RefreshLogTone, message: string): void => {
    if (!currentJob) return;
    const entry: RefreshLogEntry = {
      at: new Date().toISOString(),
      tone,
      message,
    };
    currentJob.logs.push(entry);
    if (currentJob.logs.length > 200) {
      currentJob.logs.splice(0, currentJob.logs.length - 200);
    }
  };

  const setProgress = (progress: Partial<RefreshProgressState>): void => {
    if (!currentJob) return;
    currentJob.progress = {
      ...currentJob.progress,
      ...progress,
    };
  };

  const finalizeJob = (result: RefreshResult | null, errorMessage: string | null = null): void => {
    if (!currentJob) return;
    currentJob.running = false;
    currentJob.finishedAt = new Date().toISOString();
    currentJob.result = result;
    if (errorMessage) {
      currentJob.progress.errorMessage = errorMessage;
    }
    lastJob = cloneJob(currentJob);
  };

  return {
    async start(apiKey: string): Promise<PublicRefreshJobState> {
      if (currentJob) {
        throw new Error("Refresh already running");
      }

      currentJob = {
        jobId: randomUUID(),
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        apiKeyLabel: `...${apiKey.trim().slice(-6)}`,
        progress: createInitialProgress(),
        logs: [],
        controller: new AbortController(),
        result: null,
      };
      appendLog("info", "Starting DEX refresh.");

      const refreshPromise = runDexRefresh({
        cwd,
        apiKey,
        signal: currentJob.controller.signal,
        callbacks: {
          onLog: (tone, message) => appendLog(tone, message),
          onProgress: (progress) => setProgress(progress),
        },
      })
        .then((result) => {
          finalizeJob(result);
          if (currentJob) {
            currentJob.progress = {
              ...currentJob.progress,
              status: result.status,
              errorMessage:
                result.status === "failed"
                  ? "All entity fetches failed"
                  : result.status === "canceled"
                    ? "Refresh canceled by user"
                    : null,
            };
            lastJob = cloneJob(currentJob);
          }
        })
        .catch((error) => {
          if (!currentJob) return;
          if (isAbortError(error)) {
            currentJob.running = false;
            currentJob.finishedAt = new Date().toISOString();
            currentJob.progress.status = "canceled";
            currentJob.progress.errorMessage = "Refresh canceled by user";
            appendLog("warning", "Refresh canceled by user.");
            lastJob = cloneJob(currentJob);
            currentJob = null;
            return;
          }
          const message = (error as Error).message || "Refresh failed";
          currentJob.running = false;
          currentJob.finishedAt = new Date().toISOString();
          currentJob.progress.status = "failed";
          currentJob.progress.errorMessage = message;
          appendLog("error", message);
          lastJob = cloneJob(currentJob);
        })
        .finally(() => {
          if (currentJob) {
            currentJob.running = false;
            lastJob = cloneJob(currentJob);
          }
          if (currentJob?.result) {
            currentJob.progress.status = currentJob.result.status;
          }
          currentJob = null;
        });

      if (process.env.VERCEL) {
        waitUntil(refreshPromise);
      } else {
        void refreshPromise;
      }

      return cloneJob(currentJob)!;
    },

    cancel(): boolean {
      if (!currentJob?.running) return false;
      currentJob.controller.abort();
      appendLog("warning", "Cancel requested by user.");
      return true;
    },

    getCurrent(): PublicRefreshJobState | null {
      return cloneJob(currentJob);
    },

    getLatest(): PublicRefreshJobState | null {
      return lastJob ? { ...lastJob, progress: { ...lastJob.progress }, logs: lastJob.logs.map((entry) => ({ ...entry })), result: lastJob.result ? { ...lastJob.result } : null } : null;
    },
  };
}
