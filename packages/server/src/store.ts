import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { DEFAULT_STATE, type ServerState } from "./types.js";

function normalizeState(state: ServerState | null | undefined): ServerState {
  return {
    feeds: Array.isArray(state?.feeds) ? state.feeds : [],
    groups: Array.isArray(state?.groups) ? state.groups : [],
    articles: Array.isArray(state?.articles) ? state.articles : [],
    settings: {
      refreshIntervalMinutes:
        typeof state?.settings?.refreshIntervalMinutes === "number" && Number.isFinite(state.settings.refreshIntervalMinutes)
          ? state.settings.refreshIntervalMinutes
          : DEFAULT_STATE.settings.refreshIntervalMinutes
    }
  };
}

export class StateStore {
  private readonly db: Low<ServerState>;
  private readonly ready: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    const adapter = new JSONFile<ServerState>(filePath);
    this.db = new Low<ServerState>(adapter, structuredClone(DEFAULT_STATE));
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.db.read();
    this.db.data = normalizeState(this.db.data);
    await this.db.write();
  }

  async read(): Promise<ServerState> {
    await this.ready;
    this.db.data = normalizeState(this.db.data);
    return structuredClone(this.db.data!);
  }

  async mutate(mutator: (state: ServerState) => void | Promise<void>): Promise<ServerState> {
    await this.ready;
    this.mutationQueue = this.mutationQueue.then(async () => {
      this.db.data = normalizeState(this.db.data);
      await mutator(this.db.data!);
      this.db.data = normalizeState(this.db.data);
      await this.db.write();
    });
    await this.mutationQueue;
    return structuredClone(this.db.data!);
  }
}
