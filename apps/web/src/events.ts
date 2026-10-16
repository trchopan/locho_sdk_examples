export type NoteChange = { operation: 'created' | 'updated' | 'deleted'; noteId: string };

/** Bounded SSE decoder. Transport chunks are not UTF-8, line or event boundaries. */
export class NoteEventParser {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private event = '';
  private data: string[] = [];
  private bytes = 0;
  private cr = false;
  private encoder = new TextEncoder();
  constructor(private changed: (change: NoteChange) => void) {}
  push(chunk: Uint8Array) {
    // Streaming decode retains partial UTF-8, with at most one bounded line/event.
    for (const character of this.decoder.decode(chunk, { stream: true })) {
      if (this.cr) { this.cr = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') {
        this.acceptLine(); this.cr = character === '\r';
      } else {
        this.line += character;
        this.bytes += this.encoder.encode(character).length;
        if (this.bytes > 4096) throw new Error('Event limit');
      }
    }
  }
  end() { this.decoder.decode(); /* incomplete final event is never dispatched */ }
  private acceptLine() {
    const line = this.line; this.line = '';
    if (!line) {
      if (this.event === 'note.changed' && this.data.length) {
        const value = JSON.parse(this.data.join('\n'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'noteId,operation'
          || !['created', 'updated', 'deleted'].includes(value.operation)
          || typeof value.noteId !== 'string' || !value.noteId.length || [...value.noteId].length > 128) throw new Error('Invalid event');
        this.changed(value);
      }
      this.event = ''; this.data = []; this.bytes = 0;
    } else if (line.startsWith(':')) { this.bytes -= this.encoder.encode(line).length; }
    else {
      if (++this.bytes > 4096) throw new Error('Event limit');
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      if (field === 'data') this.data.push(value);
      // id/retry and unknown events are ignored; no replay or server retry policy.
    }
  }
}

export interface EventTransport {
  fetchStream(path: string, options: { headers: Record<string, string>; signal: AbortSignal; setupTimeoutMs: number; idleTimeoutMs: number }): Promise<Response>;
}
class Admission extends Error { constructor(readonly status: number, readonly retryMs = 0) { super('Event admission'); } }
export type LiveState = 'off' | 'connecting' | 'live' | 'reconnecting';
export type EventOptions = { retryBaseMs?: number; random?: () => number };

/** One owner, one stream, one retry timer. Application writes are never retried. */
export class NoteEventWatch {
  private abort = new AbortController();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  private work?: Promise<void>;
  private first!: () => void;
  constructor(private transport: EventTransport, private token: string, private callbacks: {
    validate: () => Promise<void>; refresh: () => void; unauthorized: () => Promise<void>;
    state: (state: LiveState) => void;
  }, private options: EventOptions = {}) {}
  start(): Promise<void> {
    const first = new Promise<void>((resolve) => { this.first = resolve; });
    this.work = this.run(); return first;
  }
  async stop() {
    this.abort.abort(); clearTimeout(this.timer); this.wake?.();
    await this.reader?.cancel().catch(() => {});
    await this.work;
  }
  reconnect() { void this.reader?.cancel().catch(() => {}); }
  private async run() {
    let attempt = 0, retry = false;
    while (!this.abort.signal.aborted) {
      let retryAfter = 0;
      try {
        this.callbacks.state(retry ? 'reconnecting' : 'connecting');
        if (retry) await this.callbacks.validate();
        if (this.abort.signal.aborted) break;
        const response = await this.transport.fetchStream('/api/events', {
          headers: { Authorization: `Bearer ${this.token}` }, signal: this.abort.signal,
          setupTimeoutMs: 15000, idleTimeoutMs: 75000,
        });
        if (this.abort.signal.aborted) { await response.body?.cancel(); break; }
        if (response.status !== 200) {
          const seconds = response.headers.get('retry-after');
          await response.body?.cancel();
          throw new Admission(response.status, response.status === 429 && seconds && /^\d+$/.test(seconds) ? Math.min(Number(seconds), 300) * 1000 : 0);
        }
        if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
          await response.body?.cancel(); throw new Error('Invalid event stream');
        }
        this.reader = response.body.getReader();
        this.callbacks.state('live');
        if (retry) this.callbacks.refresh();
        this.first();
        const parser = new NoteEventParser(() => this.callbacks.refresh());
        const opened = Date.now();
        for (;;) {
          const { done, value } = await this.reader.read();
          if (this.abort.signal.aborted) break;
          if (done) { parser.end(); break; }
          parser.push(value);
          if (Date.now() - opened >= 30000) attempt = 0;
        }
      } catch (error) {
        if (this.abort.signal.aborted) break;
        if (error instanceof Admission && error.status === 401) { await this.callbacks.unauthorized(); break; }
        if (error instanceof Admission) retryAfter = error.retryMs;
      } finally {
        await this.reader?.cancel().catch(() => {});
        this.reader?.releaseLock(); this.reader = undefined; this.first();
      }
      if (this.abort.signal.aborted) break;
      this.callbacks.state('reconnecting'); retry = true;
      const delay = Math.max(retryAfter, Math.min(30000, (this.options.retryBaseMs ?? 1000) * 2 ** Math.min(attempt++, 5) * (0.75 + (this.options.random ?? Math.random)() * 0.5)));
      await new Promise<void>((resolve) => { this.wake = resolve; this.timer = setTimeout(resolve, delay); });
      this.wake = undefined;
    }
  }
}
