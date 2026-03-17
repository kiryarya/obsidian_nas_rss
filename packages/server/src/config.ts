import path from "node:path";

const rootDir = process.cwd();

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const serverConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: readNumber(process.env.PORT, 43112),
  refreshIntervalMinutes: readNumber(process.env.RSS_REFRESH_INTERVAL_MINUTES, 30),
  readRetentionDays: readNumber(process.env.RSS_READ_RETENTION_DAYS, 30),
  dataFilePath:
    process.env.RSS_SERVER_DATA_FILE ??
    path.resolve(rootDir, "data", "rss-state.json")
};
