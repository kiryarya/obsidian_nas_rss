import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { DEFAULT_STATE, type ServerState } from "./types.js";

export class StateStore {
  private readonly db: Low<ServerState>;
  private readonly ready: Promise<void>;

  constructor(private readonly filePath: string) {
    const adapter = new JSONFile<ServerState>(filePath);
    this.db = new Low<ServerState>(adapter, structuredClone(DEFAULT_STATE));
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.db.read();
    this.db.data ??= structuredClone(DEFAULT_STATE);
    await this.db.write();
  }

  async read(): Promise<ServerState> {
    await this.ready;
    return structuredClone(this.db.data!);
  }

  async mutate(mutator: (state: ServerState) => void | Promise<void>): Promise<ServerState> {
    await this.ready;
    await mutator(this.db.data!);
    await this.db.write();
    return structuredClone(this.db.data!);
  }
}
