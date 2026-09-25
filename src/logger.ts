import { env } from './env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Strukturierte JSON-Logs in der Produktion, lesbare
 * Zeilen beim Entwickeln. Kein externer Logger, damit das Image klein bleibt.
 */
function emit(level: Level, message: string, context?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[env.logLevel]) return;
  if (env.isProduction) {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), level, message, ...context }) + '\n',
    );
    return;
  }
  const tint = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level];
  const extra = context && Object.keys(context).length ? ' ' + JSON.stringify(context) : '';
  process.stdout.write(`${tint}${level.padEnd(5)}\x1b[0m ${message}${extra}\n`);
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
};

/** Fehler so serialisieren, dass Stacktrace und Ursache im Log landen. */
export function errorContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error: error.message,
      stack: error.stack,
      cause: error.cause instanceof Error ? error.cause.message : undefined,
    };
  }
  return { error: String(error) };
}
