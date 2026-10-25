import { GATEWAY, GATEWAY_HEADER } from './gateway';
import type { Pairing, Transport } from './session';

type Reply = { ok: boolean; id: string; label: string; reset?: boolean };

export class CookieBridge {
  private worker?: ServiceWorker;
  private id?: string;
  private startup?: Promise<void>;
  constructor(private reset: () => void) {}
  private async ready() {
    if (!this.startup)
      this.startup = this.start().catch((error) => {
        this.startup = undefined;
        throw error;
      });
    await this.startup;
    if (this.worker !== navigator.serviceWorker.controller)
      throw new Error('Worker update requires reload');
  }
  private async start() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext)
      throw new Error('Secure context required');
    const base = new URL(import.meta.env.BASE_URL, location.href);
    const script = new URL('locho-notes-sw.js', base);
    const existing = await navigator.serviceWorker.getRegistration(base.href);
    const matching = existing?.scope === base.href ? existing : undefined;
    if (matching?.active && matching.active.scriptURL !== script.href)
      throw new Error('Application scope is controlled by another worker');
    // Control operations should reuse the registration, not await update checks
    // while a foreground streamed response is active.
    const registration =
      matching ??
      (await navigator.serviceWorker.register(script, {
        type: 'module',
        scope: base.pathname,
        updateViaCache: 'none',
      }));
    await new Promise<void>((resolve, reject) => {
      const candidate = registration.active ?? registration.installing ?? registration.waiting;
      if (!candidate) {
        reject(new Error('Worker installation failed'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Worker installation timeout'));
      }, 15000);
      const cleanup = () => {
        clearTimeout(timer);
        candidate.removeEventListener('statechange', changed);
      };
      const changed = () => {
        if (candidate.state === 'activated') {
          cleanup();
          resolve();
        } else if (candidate.state === 'redundant') {
          cleanup();
          reject(new Error('Worker installation failed'));
        }
      };
      candidate.addEventListener('statechange', changed);
      changed();
    });
    if (navigator.serviceWorker.controller !== registration.active) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Worker activation timeout'));
        }, 15000);
        const cleanup = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
        };
        const changed = () => {
          if (navigator.serviceWorker.controller === registration.active) {
            cleanup();
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        // An existing active registration can be visible before this new window
        // is controlled (notably Firefox). Activation's one-time claim is not
        // enough for every subsequent window; request a scoped claim explicitly.
        registration.active?.postMessage({ protocol: 'locho-notes-claim-v1' });
        changed();
      });
    }
    this.worker = registration.active ?? undefined;
    if (!this.worker || this.worker !== navigator.serviceWorker.controller)
      throw new Error('Worker update requires reload');
  }
  private async command(action: string, id?: string, ticket?: string, signal?: AbortSignal) {
    await this.ready();
    if (signal?.aborted) throw new Error('Cancelled');
    const worker = this.worker;
    if (!worker) throw new Error('Worker unavailable');
    return new Promise<Reply>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('Worker command timeout'));
      }, 30000);
      channel.port1.onmessage = ({ data }: MessageEvent<Reply>) => {
        clearTimeout(timer);
        channel.port1.close();
        if (data?.ok && typeof data.id === 'string' && typeof data.label === 'string')
          resolve(data);
        else {
          if (data?.reset && this.id === id && action === 'connect') this.reset();
          reject(new Error('Worker command rejected; pair again'));
        }
      };
      worker.postMessage({ protocol: 'locho-notes-v1', action, id, ticket }, [channel.port2]);
    });
  }
  async pair(ticket: string): Promise<Pairing> {
    const reply = await this.command('pair', undefined, ticket);
    this.id = reply.id;
    // Ticket text is not captured by the returned Pairing or transport.
    return {
      key: reply.id,
      label: reply.label,
      forget: () =>
        this.command('forget', reply.id).then(
          () => {},
          () => {},
        ),
      connect: async (signal) => {
        if (signal.aborted) throw new Error('Cancelled');
        const cancel = () => {
          void this.command('disconnect', reply.id).catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          await this.command('connect', reply.id, undefined, signal);
        } catch (error) {
          await this.command('disconnect', reply.id).catch(() => {});
          throw error;
        } finally {
          signal.removeEventListener('abort', cancel);
        }
        if (signal.aborted) {
          await this.command('disconnect', reply.id);
          throw new Error('Cancelled');
        }
        return this.transport(reply.id);
      },
    };
  }
  async forget() {
    const id = this.id;
    this.id = undefined;
    if (id) await this.command('forget', id).catch(() => {});
  }
  private transport(id: string): Transport {
    const status = { state: 'connected' };
    const call: Transport['fetch'] = async (path, options) => {
      const headers = new Headers(options?.headers);
      headers.set(GATEWAY_HEADER, id);
      const response = await fetch(
        new URL(`${GATEWAY}${path.slice(1)}`, new URL(import.meta.env.BASE_URL, location.href)),
        {
          method: options?.method,
          headers,
          body: options?.body,
          signal: options?.signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        },
      );
      if (response.headers.get('X-Locho-Notes-Reset') === '1') {
        await response.body?.cancel();
        if (!options?.signal?.aborted && this.id === id) this.reset();
        throw new Error('Worker session lost; pair again');
      }
      if (response.headers.get('X-Locho-Notes-Transport-Error') === '1') {
        await response.body?.cancel();
        throw new Error('Locho request failed; outcome may be unknown');
      }
      return response;
    };
    return {
      get status() {
        return status;
      },
      fetch: call,
      fetchStream: (path, options) =>
        call(path, { headers: options.headers, signal: options.signal }),
      close: async () => {
        await this.command('disconnect', id).catch(() => {});
      },
      subscribeStatus: (listener) => {
        const changed = (event: MessageEvent) => {
          const data = event.data;
          if (
            event.source === this.worker &&
            data?.protocol === 'locho-notes-status-v1' &&
            data.id === id &&
            this.id === id &&
            ['connecting', 'connected', 'reconnecting', 'failed', 'closed'].includes(data.state)
          ) {
            status.state = data.state;
            listener(status);
          }
        };
        navigator.serviceWorker.addEventListener('message', changed);
        return async () => {
          navigator.serviceWorker.removeEventListener('message', changed);
        };
      },
    };
  }
}
