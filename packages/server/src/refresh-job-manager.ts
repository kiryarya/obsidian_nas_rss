export type RefreshJobStatus = "idle" | "running" | "completed" | "failed";

export interface RefreshJob {
  id: string;
  status: RefreshJobStatus;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  targetFeedId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class RefreshJobManager {
  private currentJob: RefreshJob = {
    id: "initial",
    status: "idle"
  };

  getCurrentJob(): RefreshJob {
    return { ...this.currentJob };
  }

  startJob(targetFeedId?: string): RefreshJob {
    this.currentJob = {
      id: `${Date.now()}`,
      status: "running",
      startedAt: nowIso(),
      targetFeedId
    };
    return this.getCurrentJob();
  }

  completeJob(): RefreshJob {
    this.currentJob = {
      ...this.currentJob,
      status: "completed",
      completedAt: nowIso(),
      errorMessage: undefined
    };
    return this.getCurrentJob();
  }

  failJob(errorMessage: string): RefreshJob {
    this.currentJob = {
      ...this.currentJob,
      status: "failed",
      completedAt: nowIso(),
      errorMessage
    };
    return this.getCurrentJob();
  }
}
