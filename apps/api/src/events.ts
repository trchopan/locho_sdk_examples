import { PassThrough } from 'node:stream';

export type NoteChange = { operation: 'created' | 'updated' | 'deleted'; noteId: string };
type Subscriber = { userId: string; tokenHash: string; stream: PassThrough };
export const EVENT_LIMITS = { perUser: 4, total: 64, frameBytes: 1024, bufferBytes: 4096 } as const;

/** Process-local invalidations, no event history or replay. Slow consumers disconnect. */
export class NoteEvents {
  private subscribers = new Set<Subscriber>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private valid: (tokenHash: string) => boolean, tickMs = 30000) {
    if (!Number.isSafeInteger(tickMs) || tickMs < 10 || tickMs > 30000) throw new Error('Invalid events interval');
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref();
  }
  subscribe(userId: string, tokenHash: string): PassThrough | undefined {
    if (this.closed || this.subscribers.size >= EVENT_LIMITS.total
      || [...this.subscribers].filter((s) => s.userId === userId).length >= EVENT_LIMITS.perUser) return undefined;
    const stream = new PassThrough({ highWaterMark: EVENT_LIMITS.bufferBytes });
    const subscriber = { userId, tokenHash, stream };
    this.subscribers.add(subscriber);
    stream.once('close', () => this.subscribers.delete(subscriber));
    // End/drain/cancel races must never emit an unhandled stream error.
    stream.on('error', () => this.remove(subscriber));
    this.write(subscriber, ': connected\n\n');
    return stream;
  }
  private remove(subscriber: Subscriber) {
    this.subscribers.delete(subscriber);
    subscriber.stream.destroy();
  }
  private write(subscriber: Subscriber, frame: string) {
    if (Buffer.byteLength(frame) > EVENT_LIMITS.frameBytes || !subscriber.stream.write(frame)) this.remove(subscriber);
  }
  private authorized(subscriber: Subscriber): boolean {
    try { if (this.valid(subscriber.tokenHash)) return true; } catch { /* fail closed without leaking database errors */ }
    this.remove(subscriber); return false;
  }
  private tick() {
    for (const subscriber of this.subscribers) {
      if (this.authorized(subscriber)) this.write(subscriber, ': heartbeat\n\n');
    }
  }
  publish(userId: string, change: NoteChange) {
    const frame = `event: note.changed\ndata: ${JSON.stringify(change)}\n\n`;
    for (const subscriber of this.subscribers) {
      if (subscriber.userId === userId && this.authorized(subscriber)) this.write(subscriber, frame);
    }
  }
  revoke(tokenHash: string) {
    for (const subscriber of this.subscribers) if (subscriber.tokenHash === tokenHash) this.remove(subscriber);
  }
  close() {
    this.closed = true; clearInterval(this.timer);
    for (const subscriber of this.subscribers) this.remove(subscriber);
  }
  /** Test/operational aggregate only; never expose identities, tokens or streams. */
  get active(): number { return this.subscribers.size; }
}
