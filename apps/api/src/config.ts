import { resolve } from 'node:path';

function positiveInteger(name: string, fallback: number, max: number): number {
  const input = process.env[name];
  if (input === undefined) return fallback;
  if (!/^\d+$/.test(input)) throw new Error(`Invalid ${name}`);
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function databasePath(): string {
  // Commands execute from apps/api, including npm workspace scripts.
  return resolve(process.env.API_DATABASE ?? '../../.data/notes.sqlite');
}

export function configuration() {
  return {
    databasePath: databasePath(),
    host: process.env.API_HOST ?? '127.0.0.1',
    port: positiveInteger('API_PORT', 8080, 65535),
    sessionLifetimeMs: positiveInteger('API_SESSION_SECONDS', 30 * 86400, 365 * 86400) * 1000,
    loginAttempts: positiveInteger('API_LOGIN_ATTEMPTS', 10, 1000),
    loginWindowMs: positiveInteger('API_LOGIN_WINDOW_SECONDS', 60, 86400) * 1000,
  };
}
