import process from "node:process";

const levels = { debug: 0, info: 1, error: 2 } as const;
type Level = keyof typeof levels;

function log(level: Level, message: string, requestId?: string): void {
  const configured = process.env.LOG_LEVEL;
  const threshold =
    configured && configured in levels
      ? levels[configured as Level]
      : levels.debug;
  if (levels[level] < threshold) return;
  const entry = `${JSON.stringify({ level, message, ...(requestId ? { request_id: requestId } : {}) })}\n`;
  if (typeof process.stderr?.write === "function") process.stderr.write(entry);
  else console.error(entry.trimEnd());
}

export const logger = {
  debug: (message: string, requestId?: string): void =>
    log("debug", message, requestId),
  info: (message: string, requestId?: string): void =>
    log("info", message, requestId),
  error: (message: string, requestId?: string): void =>
    log("error", message, requestId),
};
