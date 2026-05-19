/**
 * Lightweight logger for the vendored WeChat protocol layer.
 * Delegates to an optional bridge-injected log function; defaults to stderr for warn/error only.
 */

export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  withAccount(accountId: string): Logger;
};

let bridgeLog: ((msg: string) => void) | null = null;
let verbose = false;

export function initWeixinLogger(opts?: { log?: (msg: string) => void; verbose?: boolean }): void {
  bridgeLog = opts?.log ?? null;
  verbose = Boolean(opts?.verbose);
}

function emit(level: string, message: string): void {
  const line = `[weixin] ${message}`;
  if (bridgeLog) {
    bridgeLog(`${level} ${message}`);
    return;
  }
  if (level === "ERROR" || level === "WARN") {
    console.error(line);
  } else if (verbose && (level === "DEBUG" || level === "INFO")) {
    console.error(line);
  }
}

function makeLogger(prefix?: string): Logger {
  const p = prefix ? `${prefix} ` : "";
  return {
    info: (m) => emit("INFO", `${p}${m}`),
    debug: (m) => emit("DEBUG", `${p}${m}`),
    warn: (m) => emit("WARN", `${p}${m}`),
    error: (m) => emit("ERROR", `${p}${m}`),
    withAccount: (accountId) => makeLogger(`[${accountId}]`),
  };
}

export const logger: Logger = makeLogger();
