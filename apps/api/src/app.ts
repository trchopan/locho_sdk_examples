import Fastify, { LogController, type FastifyRequest, type FastifyReply, type FastifyServerOptions, type FastifyError } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { openDatabase } from './database.js';
import { hashPassword, verifyPassword } from './password.js';
import { NoteEvents } from './events.js';

// Same schemas referenced by OpenAPI. Resolve from source and compiled dist paths.
const schemas = JSON.parse(readFileSync(new URL(
  import.meta.url.endsWith('.ts') ? '../../../contracts/schemas.json' : '../../../../contracts/schemas.json',
  import.meta.url,
), 'utf8')).definitions as Record<string, Record<string, unknown>>;

export type User = { id: string; email: string };
type Session = { user: User; tokenHash: string; expiresAt: number };
type NoteRow = { id: string; title: string; body: string; created_at: string; updated_at: string };
export type AppOptions = {
  databasePath?: string;
  sessionLifetimeMs?: number;
  loginAttempts?: number;
  loginWindowMs?: number;
  clock?: () => number;
  logger?: FastifyServerOptions['logger'];
  /** Shorter interval for deterministic tests; maximum/default 30 seconds. */
  eventsTickMs?: number;
};

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const invalidRequest = () => new ApiFailure(400, 'invalid_request', 'Request fields are invalid.');
const unauthorized = () => new ApiFailure(401, 'invalid_session', 'A valid session is required.');
const notFound = () => new ApiFailure(404, 'not_found', 'Resource not found.');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const noteOutput = (row: NoteRow) => ({
  id: row.id, title: row.title, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
});

function validUnicode(value: string): boolean { return value.isWellFormed(); }
function emailValue(value: string): string {
  const email = value.trim().toLowerCase();
  if (!validUnicode(email) || Buffer.byteLength(email) > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalidRequest();
  return email;
}
function passwordValue(value: string): string {
  if (!validUnicode(value) || Buffer.byteLength(value) > 1024) throw invalidRequest();
  return value;
}
function noteValues(input: { title?: string; body?: string }): { title?: string; body?: string } {
  const output: { title?: string; body?: string } = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!validUnicode(title) || [...title].length < 1 || [...title].length > 200 || /[\x00-\x1f]/u.test(input.title)) throw invalidRequest();
    output.title = title;
  }
  if (input.body !== undefined) {
    if (!validUnicode(input.body) || Buffer.byteLength(input.body) > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(input.body)) throw invalidRequest();
    output.body = input.body;
  }
  return output;
}

export async function createApp(options: AppOptions = {}) {
  const clock = options.clock ?? Date.now;
  const lifetime = options.sessionLifetimeMs ?? 30 * 86400 * 1000;
  const loginAttempts = options.loginAttempts ?? 10;
  const loginWindowMs = options.loginWindowMs ?? 60000;
  for (const value of [lifetime, loginAttempts, loginWindowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid API configuration');
  }
  const dummyHash = await hashPassword(randomBytes(32).toString('base64url'));
  const db = openDatabase(options.databasePath ?? ':memory:');
  const events = new NoteEvents((hash) => Boolean(db.prepare(
    'SELECT 1 FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
  ).get(hash, clock())), options.eventsTickMs);
  const app = Fastify({
    forceCloseConnections: true,
    bodyLimit: 64 * 1024,
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  for (const [name, schema] of Object.entries(schemas)) {
    const withRefs = JSON.parse(JSON.stringify(schema).replaceAll('#/definitions/', 'notes:'));
    // Reference IDs require a trailing # for Fastify/Ajv resolution.
    const convertRefs = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === '$ref' && typeof item === 'string') (value as Record<string, unknown>)[key] = `${item}#`;
        else convertRefs(item);
      }
    };
    convertRefs(withRefs);
    app.addSchema({ ...withRefs, $id: `notes:${name}` });
  }
  const responseSchema = (name: string) => ({ $ref: `notes:${name}#` });
  const attempts = new Map<string, { count: number; until: number }>();
  const maxLoginKeys = 10000;
  let pruneAt = 0;

  app.addHook('onRequest', async (request, reply) => {
    if (request.url !== '/health') reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const frameworkError = error as FastifyError;
    let failure: ApiFailure;
    if (error instanceof ApiFailure) failure = error;
    else if (frameworkError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') failure = new ApiFailure(413, 'payload_too_large', 'Request exceeds 64 KiB.');
    else if (frameworkError.validation || (frameworkError.statusCode !== undefined && frameworkError.statusCode >= 400 && frameworkError.statusCode < 500)) failure = invalidRequest();
    else {
      failure = new ApiFailure(500, 'internal_error', 'Internal server error.');
      // Intentionally no request/exception serialization: it may contain credentials.
      request.log.error({ requestId: request.id }, 'API request failed');
    }
    reply.code(failure.status).send({ error: { code: failure.code, message: failure.message } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Resource not found.' } }));
  app.addHook('onClose', async () => { db.close(); });
  // Close streams before Fastify waits for active HTTP responses during shutdown.
  app.addHook('preClose', async () => { events.close(); });

  function session(request: FastifyRequest): Session {
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) throw unauthorized();
    const token = authorization.slice(7);
    const hash = tokenHash(token);
    const row = db.prepare(`SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(hash, clock()) as
      { id: string; email: string; expires_at: number } | undefined;
    if (!row) throw unauthorized();
    return { user: { id: row.id, email: row.email }, tokenHash: hash, expiresAt: row.expires_at };
  }
  async function authenticated(request: FastifyRequest) { session(request); }
  function limitLogin(email: string, reply: FastifyReply) {
    const now = clock();
    if (now >= pruneAt) {
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      pruneAt = now + loginWindowMs;
    }
    const key = tokenHash(email);
    let value = attempts.get(key);
    if (value && value.until <= now) { attempts.delete(key); value = undefined; }
    if ((!value && attempts.size >= maxLoginKeys) || (value && value.count >= loginAttempts)) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil(((value?.until ?? pruneAt) - now) / 1000))));
      throw new ApiFailure(429, 'rate_limited', 'Too many login attempts. Try again later.');
    }
    if (value) value.count += 1;
    else attempts.set(key, { count: 1, until: now + loginWindowMs });
  }

  app.get('/health', { schema: { response: { 200: responseSchema('Health') } } }, async () => ({ service: 'locho-notes', apiVersion: 1 }));
  app.post<{ Body: { email: string; password: string } }>('/auth/login', {
    schema: { body: responseSchema('LoginInput'), response: { 200: responseSchema('Login') } },
  }, async (request, reply) => {
    const email = emailValue(request.body.email);
    const password = passwordValue(request.body.password);
    limitLogin(email, reply);
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as
      { id: string; email: string; password_hash: string } | undefined;
    const valid = await verifyPassword(user?.password_hash ?? dummyHash, password);
    if (!user || !valid) throw new ApiFailure(401, 'invalid_credentials', 'Email or password is incorrect.');
    const now = clock();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + lifetime;
    db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash(token), user.id, now, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString(), user: { id: user.id, email: user.email } };
  });
  app.get('/api/me', { schema: { response: { 200: responseSchema('Me') } } }, async (request) => {
    const current = session(request);
    return { user: current.user, expiresAt: new Date(current.expiresAt).toISOString() };
  });
  app.post('/auth/logout', async (request, reply) => {
    const current = session(request);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(clock(), current.tokenHash);
    events.revoke(current.tokenHash);
    return reply.code(204).send();
  });
  app.get('/api/events', async (request, reply) => {
    const current = session(request);
    const stream = events.subscribe(current.user.id, current.tokenHash);
    if (!stream) {
      reply.header('Retry-After', '30');
      throw new ApiFailure(429, 'rate_limited', 'Event subscription limit reached.');
    }
    reply.header('Content-Type', 'text/event-stream; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Accel-Buffering', 'no');
    // Fastify destroys piped streams on client cancellation; explicitly retain the
    // close binding so admission capacity is released on all socket teardown paths.
    reply.raw.once('close', () => stream.destroy());
    stream.once('close', () => { if (!reply.raw.writableEnded) reply.raw.destroy(); });
    return reply.send(stream);
  });
  app.get('/api/notes', { schema: { response: { 200: responseSchema('Notes') } } }, async (request) => {
    const current = session(request);
    const rows = db.prepare('SELECT id, title, body, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC, id ASC')
      .all(current.user.id) as NoteRow[];
    const result = { notes: rows.map(noteOutput) };
    if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new Error('Response size limit');
    return result;
  });
  app.post<{ Body: { title: string; body: string } }>('/api/notes', {
    onRequest: authenticated,
    schema: { body: responseSchema('CreateNote'), response: { 201: responseSchema('NoteResult') } },
  }, async (request, reply) => {
    const current = session(request);
    const values = noteValues(request.body);
    const now = new Date(clock()).toISOString();
    const note = { id: randomUUID(), title: values.title!, body: values.body!, createdAt: now, updatedAt: now };
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = db.prepare('SELECT count(*) AS count FROM notes WHERE user_id = ?').get(current.user.id) as { count: number };
      if (count.count >= 100) throw new ApiFailure(409, 'note_limit', 'This demonstration account has reached 100 notes.');
      db.prepare('INSERT INTO notes(id, user_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(note.id, current.user.id, note.title, note.body, now, now);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    events.publish(current.user.id, { operation: 'created', noteId: note.id });
    return reply.code(201).send({ note });
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; body?: string } }>('/api/notes/:id', {
    onRequest: authenticated,
    schema: { body: responseSchema('PatchNote'), response: { 200: responseSchema('NoteResult') } },
  }, async (request) => {
    const current = session(request);
    const values = noteValues(request.body);
    const row = db.prepare('SELECT id, title, body, created_at, updated_at FROM notes WHERE id = ? AND user_id = ?')
      .get(request.params.id, current.user.id) as NoteRow | undefined;
    if (!row) throw notFound();
    row.title = values.title ?? row.title; row.body = values.body ?? row.body;
    row.updated_at = new Date(clock()).toISOString();
    db.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(row.title, row.body, row.updated_at, row.id, current.user.id);
    events.publish(current.user.id, { operation: 'updated', noteId: row.id });
    return { note: noteOutput(row) };
  });
  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (request, reply) => {
    const current = session(request);
    const result = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(request.params.id, current.user.id);
    if (result.changes === 0) throw notFound();
    events.publish(current.user.id, { operation: 'deleted', noteId: request.params.id });
    return reply.code(204).send();
  });
  return { app, db };
}

export async function addUser(db: DatabaseSync, email: string, password: string): Promise<User> {
  const normalized = emailValue(email);
  passwordValue(password);
  if (password.length === 0) throw invalidRequest();
  const id = randomUUID();
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users(id, email, password_hash) VALUES (?, ?, ?)').run(id, normalized, hash);
  return { id, email: normalized };
}
