export type User = { id: string; email: string };
export type Note = { id: string; title: string; body: string; createdAt: string; updatedAt: string };
export interface Transport {
  fetch(path: string, options?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
  close(): Promise<void>;
}
export interface Pairing { key: string; label: string; connect(signal: AbortSignal): Promise<Transport> }
type Auth = { token: string; expiresAt: string; user: User };
export type State = {
  phase: 'unpaired' | 'disconnected' | 'connecting' | 'checking' | 'login' | 'notes';
  label: string; user?: User; notes: Note[]; busy: boolean; message: string;
};
class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super('API failure'); } }
class Obsolete extends Error {}
const initial = (): State => ({ phase: 'unpaired', label: '', notes: [], busy: false, message: '' });

export class Session {
  state = initial();
  private listeners = new Set<() => void>();
  private pairing?: Pairing;
  private auth?: Auth;
  private client?: Transport;
  private generation = 0;
  private cancel = new AbortController();
  private teardown: Promise<void> = Promise.resolve();
  constructor(private parse: (value: string) => Promise<Pairing>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  private invalidate(close = true) {
    this.generation++; this.cancel.abort(); this.cancel = new AbortController();
    const client = this.client; this.client = undefined;
    if (close) this.teardown = this.teardown.then(async () => { await client?.close(); }).catch(() => {});
    return this.generation;
  }
  private current(generation: number) { if (generation !== this.generation) throw new Obsolete(); }
  async pair(text: string) { await this.connectPairing(() => this.parse(text.trim())); }
  private async connectPairing(parse: () => Promise<Pairing>) {
    const generation = this.invalidate();
    this.update({ phase: 'connecting', busy: true, notes: [], user: undefined, message: '' });
    let client: Transport | undefined;
    try {
      const pairing = await parse(); this.current(generation);
      if (this.pairing?.key !== pairing.key) this.auth = undefined;
      this.pairing = pairing;
      this.update({ label: pairing.label });
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
        await this.load(generation);
      }
      this.current(generation);
      this.update({ phase: this.auth ? 'notes' : 'login', busy: false, user: this.auth?.user });
    } catch (error) {
      if (generation !== this.generation) return;
      this.client = undefined; await client?.close().catch(() => {});
      this.update({ phase: 'disconnected', busy: false, message: error instanceof ApiError && error.status === 401 ? 'Session expired. Reconnect to log in.' : 'Connection or API check failed. Check ticket, service and network.' });
    }
  }
  async reconnect() {
    const pairing = this.pairing;
    if (pairing) await this.connectPairing(async () => pairing);
  }
  disconnect() {
    this.invalidate();
    this.update({ phase: this.pairing ? 'disconnected' : 'unpaired', busy: false, notes: [], user: undefined, message: 'Disconnected. Credentials retained in this tab only.' });
  }
  forget() {
    this.invalidate(); this.pairing = undefined; this.auth = undefined; this.state = initial(); this.listeners.forEach((l) => l());
  }
  private async call(path: string, generation: number, authenticated = true, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown) {
    this.current(generation);
    if (!this.client) throw new Error('Disconnected');
    const headers: Record<string, string> = {};
    if (authenticated && this.auth) headers.Authorization = `Bearer ${this.auth.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.client.fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: this.cancel.signal, timeoutMs: 15000 });
    this.current(generation);
    if (!response.ok) {
      // Never display arbitrary backend bodies or exception text.
      if (authenticated && response.status === 401) { this.auth = undefined; this.update({ phase: 'login', user: undefined, notes: [] }); }
      throw new ApiError(response.status, 'http');
    }
    if (response.status === 204) return undefined;
    const data = await response.json(); this.current(generation); return data;
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
    } finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  login(email: string, password: string) { return this.action(async (g) => {
    const data = await this.call('/auth/login', g, false, 'POST', { email, password });
    if (typeof data?.token !== 'string' || typeof data.expiresAt !== 'string' || typeof data.user?.email !== 'string') throw new Error('Malformed API');
    this.auth = data;
    await this.load(g);
    this.update({ phase: 'notes', user: this.auth?.user });
  }); }
  private async load(g: number) {
    const data = await this.call('/api/notes', g);
    if (!Array.isArray(data?.notes) || data.notes.length > 100 || data.notes.some((n: Note) => typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.body !== 'string')) throw new Error('Malformed API');
    this.update({ notes: data.notes });
  }
  refresh() { return this.action((g) => this.load(g)); }
  save(title: string, body: string, id?: string) { return this.action(async (g) => {
    if ([...title.trim()].length < 1 || [...title.trim()].length > 200 || new TextEncoder().encode(body).length > 16000) { this.update({ message: 'Title must be 1–200 characters; body at most 16000 UTF-8 bytes.' }); return; }
    await this.call(id ? `/api/notes/${encodeURIComponent(id)}` : '/api/notes', g, true, id ? 'PATCH' : 'POST', { title, body });
    await this.load(g);
  }, true); }
  remove(id: string) { return this.action(async (g) => { await this.call(`/api/notes/${encodeURIComponent(id)}`, g, true, 'DELETE'); await this.load(g); }, true); }
  async logout() {
    const client = this.client, token = this.auth?.token;
    const generation = this.invalidate(false); this.client = undefined; this.auth = undefined;
    this.update({ phase: this.pairing ? 'disconnected' : 'unpaired', busy: true, user: undefined, notes: [], message: '' });
    let revoked = false;
    if (client && token) {
      try { revoked = (await client.fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 15000 })).status === 204; } catch {}
      await client.close().catch(() => {});
    }
    if (generation === this.generation) this.update({ busy: false, message: revoked ? 'Logged out. Reconnect to log in.' : 'Local session removed. Server revocation is unconfirmed.' });
  }
}
