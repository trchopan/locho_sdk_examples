export type User = { id: string; email: string };
import { NoteEventWatch, type EventTransport, type LiveState, type EventOptions } from './events';
export type Note = { id: string; title: string; body: string; createdAt: string; updatedAt: string };
export interface Transport {
  fetchStream?: EventTransport['fetchStream'];
  fetch(path: string, options?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
  close(): Promise<void>;
  readonly status?: { state: string };
  subscribeStatus?(listener: (status: { state: string }) => void, options?: { onError?: () => void }): () => Promise<void>;
}
import type { CredentialStore, SavedSession } from './storage';
export interface Pairing { key: string; label: string; connect(signal: AbortSignal): Promise<Transport>; export?(): string }
export type Auth = { token: string; expiresAt: string; user: User };
export type State = {
  phase: 'unpaired' | 'disconnected' | 'connecting' | 'checking' | 'login' | 'notes';
  label: string; user?: User; notes: Note[]; busy: boolean; message: string;
  remember: boolean; storageBusy: boolean; storageError: string;
  live: LiveState;
};
class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super('API failure'); } }
class Obsolete extends Error {}
const initial = (): State => ({ phase: 'unpaired', label: '', notes: [], busy: false, message: '', remember: false, storageBusy: false, storageError: '', live: 'off' });

export class Session {
  state = initial();
  private listeners = new Set<() => void>();
  private pairing?: Pairing;
  private auth?: Auth;
  private client?: Transport;
  private generation = 0;
  private cancel = new AbortController();
  private teardown: Promise<void> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private storageRevision = 0;
  private remember = false;
  private desired = false;
  private suspended = false;
  private restoring?: Promise<void>;
  private recovering = false;
  private unsubscribe?: () => Promise<void>;
  private events?: NoteEventWatch;
  private eventsCleanup: Promise<void> = Promise.resolve();
  private dirty = false;
  private loading?: { generation: number; promise: Promise<void> };
  private refreshQueued = false;
  constructor(private parse: (value: string) => Promise<Pairing>, private store?: CredentialStore, private eventOptions: EventOptions = {}) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  private invalidate(close = true) {
    this.stopEvents(); this.dirty = false; this.loading = undefined;
    this.generation++; this.cancel.abort(); this.cancel = new AbortController();
    const client = this.client; this.client = undefined;
    const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
    this.teardown = this.teardown.then(async () => {
      try { await unsubscribe?.(); } finally { if (close) await client?.close(); }
    }).catch(() => {});
    return this.generation;
  }
  private current(generation: number) { if (generation !== this.generation) throw new Obsolete(); }
  private stopEvents() {
    const events = this.events; this.events = undefined;
    this.eventsCleanup = Promise.all([this.eventsCleanup, events?.stop()]).then(() => {});
    this.update({ live: 'off' });
  }
  private async clearAuth(g: number) {
    this.current(g); this.stopEvents(); this.auth = undefined; this.dirty = false; this.loading = undefined;
    this.update({ phase: 'login', user: undefined, notes: [] });
    await this.persist(); this.current(g);
  }
  private async startEvents(g: number) {
    await this.eventsCleanup; this.current(g);
    if (!this.auth || !this.client?.fetchStream || this.events) return;
    const watch = new NoteEventWatch({ fetchStream: this.client.fetchStream.bind(this.client) }, this.auth.token, {
      state: (live) => { if (g === this.generation && this.events === watch) this.update({ live }); },
      refresh: () => { if (g === this.generation && this.events === watch) this.queueRefresh(g); },
      unauthorized: async () => { if (g === this.generation && this.events === watch) await this.clearAuth(g); },
      validate: async () => {
        this.current(g);
        const health = await this.call('/health', g, false);
        if (health?.service !== 'locho-notes' || health?.apiVersion !== 1) throw new Error('Wrong API');
        const me = await this.call('/api/me', g);
        if (!this.auth || me?.user?.id !== this.auth.user.id || typeof me.expiresAt !== 'string') throw new Error('Invalid session');
      },
    }, this.eventOptions);
    this.events = watch;
    await watch.start(); this.current(g);
  }
  private queueRefresh(g: number) {
    this.dirty = true;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (g !== this.generation || !this.auth || this.state.busy || !this.dirty) return;
      void this.load(g).catch(() => {
        // Keep action messages (especially unknown writes) independent of live updates.
        if (g === this.generation && this.auth) { this.update({ live: 'reconnecting' }); this.events?.reconnect(); }
      });
    });
  }
  private persist(): Promise<void> {
    const revision = ++this.storageRevision;
    let record: SavedSession | undefined;
    try {
      if (this.remember && this.pairing) {
        if (!this.pairing.export) throw new Error('Ticket export unavailable');
        record = { version: 1, key: this.pairing.key, ticket: this.pairing.export(), ...(this.auth ? { auth: structuredClone(this.auth) } : {}) };
      }
    } catch { this.update({ storageError: 'Credentials could not be saved. Persistence is unconfirmed.' }); return Promise.resolve(); }
    if (!this.store) return Promise.resolve();
    this.update({ storageBusy: true, storageError: '' });
    const work = async () => {
      // Discard queued obsolete writes, but always serialize behind any in-flight transaction.
      if (revision !== this.storageRevision) return;
      try {
        await this.store!.replace(record);
        if (revision === this.storageRevision) this.update({ storageError: '' });
      } catch {
        if (revision === this.storageRevision) this.update({ storageError: 'Storage failed. Saved credentials may remain; retry removal or clear site data.' });
      } finally {
        if (revision === this.storageRevision) this.update({ storageBusy: false });
      }
    };
    this.persistence = this.persistence.then(work);
    return this.persistence;
  }
  async setRemember(value: boolean) {
    this.remember = value; this.update({ remember: value }); await this.persist();
  }
  restore(): Promise<void> {
    return this.restoring ??= this.restoreSaved();
  }
  private async restoreSaved() {
    if (!this.store) return;
    const generation = this.generation, revision = this.storageRevision;
    this.update({ storageBusy: true });
    try {
      const saved = await this.store.read();
      if (generation !== this.generation || revision !== this.storageRevision) return;
      if (!saved) return;
      const pairing = await this.parse(saved.ticket);
      if (generation !== this.generation || revision !== this.storageRevision) return;
      if (pairing.key !== saved.key) throw new Error('Stored scope mismatch');
      this.pairing = pairing; this.auth = saved.auth; this.remember = true;
      this.update({ remember: true, label: pairing.label });
      if (this.suspended) { this.desired = true; this.update({ phase: 'disconnected' }); return; }
      await this.reconnect();
    } catch {
      if (generation === this.generation && revision === this.storageRevision) {
        this.update({ storageError: 'Saved credentials could not be restored. Pair again or forget saved credentials.' });
      }
    } finally {
      if (revision === this.storageRevision) this.update({ storageBusy: false });
    }
  }
  suspend() {
    this.suspended = true;
    this.invalidate();
    this.update({ phase: this.pairing ? 'disconnected' : 'unpaired', busy: false, notes: [], user: undefined, message: 'Page suspended. Credentials retained according to remember choice.' });
  }
  async resume() {
    this.suspended = false;
    if (this.desired && this.pairing && !this.client && !this.state.busy) await this.reconnect();
  }
  async observeTransport(status = this.client?.status, generation = this.generation) {
    if (generation !== this.generation || !this.desired || this.suspended || !status) return;
    const state = status.state;
    if (state === 'reconnecting' || state === 'connecting') {
      this.recovering = true;
      this.update({ phase: 'disconnected', notes: [], user: undefined, message: 'Transport reconnecting. Requests are not replayed.' });
    } else if (this.recovering && state === 'connected' && !this.state.busy) {
      this.recovering = false;
      await this.reconnect(); // Fresh health/me validation, never an old mutation.
    } else if (state === 'failed' || state === 'closed') {
      this.recovering = false;
      this.disconnect();
      this.update({ message: 'Transport stopped. Credentials retained; reconnect explicitly.' });
    }
  }
  async pair(text: string) { await this.connectPairing(() => this.parse(text.trim())); }
  private async connectPairing(parse: () => Promise<Pairing>) {
    this.desired = true;
    const generation = this.invalidate();
    this.update({ phase: 'connecting', busy: true, notes: [], user: undefined, message: '' });
    let client: Transport | undefined;
    try {
      const pairing = await parse(); this.current(generation);
      if (this.pairing?.key !== pairing.key) this.auth = undefined;
      this.pairing = pairing;
      this.update({ label: pairing.label });
      await this.persist(); this.current(generation);
      await this.teardown; this.current(generation);
      client = await pairing.connect(this.cancel.signal);
      if (generation !== this.generation) { await client.close(); return; }
      this.client = client;
      this.update({ phase: 'checking' });
      const health = await this.call('/health', generation, false);
      if (health?.service !== 'locho-notes' || health?.apiVersion !== 1) throw new Error('Wrong API');
      if (this.auth) {
        const me = await this.call('/api/me', generation);
        if (!me?.user || typeof me.expiresAt !== 'string') throw new Error('Malformed API');
        this.auth = { ...this.auth, user: me.user, expiresAt: me.expiresAt };
        await this.startEvents(generation);
        if (this.auth) await this.load(generation);
      }
      this.current(generation);
      await this.persist(); this.current(generation);
      this.update({ phase: this.auth ? 'notes' : 'login', busy: false, user: this.auth?.user });
      if (this.dirty) this.queueRefresh(generation);
      this.unsubscribe = client.subscribeStatus?.((status) => {
        void this.observeTransport(status, generation);
      }, { onError: () => {
        if (generation === this.generation) { this.disconnect(); this.update({ message: 'Status observation stopped. Reconnect explicitly.' }); }
      } });
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopEvents();
      this.client = undefined; await client?.close().catch(() => {});
      if (generation !== this.generation) return;
      this.update({ phase: 'disconnected', busy: false, message: error instanceof ApiError && error.status === 401 ? 'Session expired. Reconnect to log in.' : 'Connection or API check failed. Check ticket, service and network.' });
    }
  }
  async reconnect() {
    const pairing = this.pairing;
    if (pairing) await this.connectPairing(async () => pairing);
  }
  disconnect() {
    this.desired = false;
    this.recovering = false;
    this.invalidate();
    this.update({ phase: this.pairing ? 'disconnected' : 'unpaired', busy: false, notes: [], user: undefined, message: 'Disconnected. Credentials retained according to remember choice.' });
  }
  async forget() {
    this.desired = false; this.remember = false;
    this.recovering = false;
    this.invalidate(); this.pairing = undefined; this.auth = undefined; this.state = initial(); this.listeners.forEach((l) => l());
    await this.persist();
  }
  private async call(path: string, generation: number, authenticated = true, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown) {
    this.current(generation);
    if (!this.client) throw new Error('Disconnected');
    const token = authenticated ? this.auth?.token : undefined;
    const current = () => {
      this.current(generation);
      if (authenticated && token !== this.auth?.token) throw new Obsolete();
    };
    const headers: Record<string, string> = {};
    if (authenticated && this.auth) headers.Authorization = `Bearer ${this.auth.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.client.fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: this.cancel.signal, timeoutMs: 15000 });
    current();
    if (!response.ok) {
      // Never display arbitrary backend bodies or exception text.
      if (authenticated && response.status === 401) {
        await this.clearAuth(generation);
      }
      throw new ApiError(response.status, 'http');
    }
    if (response.status === 204) return undefined;
    const data = await response.json(); current(); return data;
  }
  private async action(run: (generation: number) => Promise<void>, mutation = false) {
    if (this.state.busy) return;
    const generation = this.generation;
    this.update({ busy: true, message: '' });
    try { await run(generation); }
    catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof ApiError
        ? error.status === 401 ? 'Login required or credentials rejected.' : `API request rejected (HTTP ${error.status}).`
        : mutation ? 'Write outcome unknown. Refresh to confirm; the request was not replayed.' : 'Request failed. Check the connection and refresh or reconnect.';
      this.update({ message });
    } finally {
      if (generation === this.generation) {
        this.update({ busy: false });
        if (this.dirty) this.queueRefresh(generation);
        if (this.recovering) void this.observeTransport();
      }
    }
  }
  login(email: string, password: string) { return this.action(async (g) => {
    const data = await this.call('/auth/login', g, false, 'POST', { email, password });
    if (typeof data?.token !== 'string' || typeof data.expiresAt !== 'string' || typeof data.user?.email !== 'string') throw new Error('Malformed API');
    this.auth = data;
    await this.persist(); this.current(g);
    await this.startEvents(g);
    if (this.auth) {
      await this.load(g);
      this.update({ phase: 'notes', user: this.auth?.user });
    }
  }); }
  private load(g: number): Promise<void> {
    if (this.loading?.generation === g) { this.dirty = true; return this.loading.promise; }
    const work = (async () => {
      do {
        this.current(g); this.dirty = false;
        const data = await this.call('/api/notes', g);
        if (!Array.isArray(data?.notes) || data.notes.length > 100 || data.notes.some((n: Note) => typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.body !== 'string')) throw new Error('Malformed API');
        this.update({ notes: data.notes });
      } while (this.dirty && this.auth);
    })();
    const promise = work.finally(() => { if (this.loading?.promise === promise) this.loading = undefined; });
    this.loading = { generation: g, promise }; return promise;
  }
  refresh() { return this.action((g) => this.load(g)); }
  save(title: string, body: string, id?: string) { return this.action(async (g) => {
    if ([...title.trim()].length < 1 || [...title.trim()].length > 200 || new TextEncoder().encode(body).length > 16000) { this.update({ message: 'Title must be 1–200 characters; body at most 16000 UTF-8 bytes.' }); return; }
    await this.call(id ? `/api/notes/${encodeURIComponent(id)}` : '/api/notes', g, true, id ? 'PATCH' : 'POST', { title, body });
    await this.load(g);
  }, true); }
  remove(id: string) { return this.action(async (g) => { await this.call(`/api/notes/${encodeURIComponent(id)}`, g, true, 'DELETE'); await this.load(g); }, true); }
  async logout() {
    this.desired = false;
    const client = this.client, token = this.auth?.token;
    const generation = this.invalidate(false); this.client = undefined; this.auth = undefined;
    this.update({ phase: this.pairing ? 'disconnected' : 'unpaired', busy: true, user: undefined, notes: [], message: '' });
    const saving = this.persist();
    let revoked = false;
    if (client && token) {
      try { revoked = (await client.fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 15000 })).status === 204; } catch {}
    }
    await client?.close().catch(() => {});
    await saving;
    if (generation === this.generation) this.update({ busy: false, message: revoked ? 'Logged out. Reconnect to log in.' : 'Local session removed. Server revocation is unconfirmed.' });
  }
}
