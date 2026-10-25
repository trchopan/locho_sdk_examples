import { initializeLocho, LochoClient, LochoTicket } from 'locho_web';
import wasmUrl from 'locho_web/wasm?url';
import { GATEWAY, GATEWAY_HEADER, GatewaySession, gatewayError } from './gateway';

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const instance = crypto.randomUUID();
class OwnerReset extends Error {}
type Owner = {
  id: string;
  ticket?: LochoTicket;
  session?: GatewaySession;
  unsubscribe?: () => Promise<void>;
  abort: AbortController;
  label: string;
};
const owners = new Map<string, Owner>();
const queues = new Map<string, Promise<unknown>>();
const connecting = new Map<string, AbortController>();
const base = new URL(worker.registration.scope);
const gatewayPath = `${base.pathname}${GATEWAY}`;

async function release(owner: Owner) {
  owner.abort.abort();
  const session = owner.session;
  owner.session = undefined;
  const unsubscribe = owner.unsubscribe;
  owner.unsubscribe = undefined;
  await unsubscribe?.().catch(() => {});
  await session?.close();
}

async function prune() {
  const clients = new Set(
    (await worker.clients.matchAll({ type: 'window' })).map((client) => client.id),
  );
  for (const [id, owner] of owners) {
    if (!clients.has(id)) {
      owners.delete(id);
      await release(owner).catch(() => {});
    }
  }
}

worker.addEventListener('activate', (event) => {
  // No skipWaiting: an update must not silently replace a live session owner.
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('message', (event) => {
  const source = event.source;
  if (source && 'id' in source && event.data?.protocol === 'locho-notes-claim-v1') {
    event.waitUntil(
      (async () => {
        const client = await worker.clients.get(source.id);
        if (
          client &&
          new URL(client.url).origin === base.origin &&
          new URL(client.url).pathname.startsWith(base.pathname)
        )
          await worker.clients.claim();
      })(),
    );
    return;
  }
  if (!source || !('id' in source) || !event.ports[0]) return;
  const clientId = source.id;
  const port = event.ports[0];
  const command = event.data;
  const knownOwner = owners.get(clientId);
  // Cancellation must interrupt a pending connect, not wait behind it in the
  // control queue. The browser-derived source and current owner must both match.
  if (
    command?.protocol === 'locho-notes-v1' &&
    knownOwner?.id === command.id &&
    ['disconnect', 'forget'].includes(command.action)
  )
    connecting.get(clientId)?.abort();
  const connectionAbort = new AbortController();
  if (command?.protocol === 'locho-notes-v1' && command.action === 'connect') {
    if (connecting.has(clientId)) {
      port.postMessage({ ok: false });
      port.close();
      return;
    }
    connecting.set(clientId, connectionAbort);
  }
  const operation = async () => {
    const client = await worker.clients.get(clientId);
    if (
      !client ||
      new URL(client.url).origin !== base.origin ||
      !new URL(client.url).pathname.startsWith(base.pathname)
    )
      throw new Error('Invalid owner');
    const data = event.data;
    if (
      data?.protocol !== 'locho-notes-v1' ||
      !['pair', 'connect', 'disconnect', 'forget'].includes(data.action)
    )
      throw new Error('Invalid command');
    await prune();
    let owner = owners.get(clientId);
    if (data.action === 'pair') {
      if (typeof data.ticket !== 'string' || data.ticket.length > 32768)
        throw new Error('Invalid ticket');
      if (!owner && owners.size >= 32) throw new Error('Owner limit');
      if (owner) await release(owner);
      owners.delete(clientId);
      await initializeLocho(wasmUrl);
      const ticket = await LochoTicket.parse(data.ticket);
      if (ticket.metadata.serviceType !== 'tcp') throw new Error('TCP ticket required');
      owner = {
        id: `${instance}/${crypto.randomUUID()}`,
        ticket,
        abort: new AbortController(),
        label: `${ticket.metadata.service} · ${ticket.metadata.hostId.slice(0, 12)}`,
      };
      owners.set(clientId, owner);
      return { id: owner.id, label: owner.label };
    }
    if (!owner || data.id !== owner.id) throw new OwnerReset();
    if (data.action === 'forget') {
      owners.delete(clientId);
      await release(owner);
    } else if (data.action === 'disconnect') {
      await release(owner);
    } else {
      await release(owner);
      if (connectionAbort.signal.aborted) throw new Error('Cancelled');
      owner.abort = connectionAbort;
      const ticket = owner.ticket;
      if (!ticket) throw new Error('Missing ticket');
      const client = await LochoClient.connect({
        ticket,
        signal: owner.abort.signal,
        http: { authority: 'sample-api' },
      });
      owner.session = new GatewaySession(client);
      const connectedOwner = owner;
      const session = owner.session;
      const postStatus = async (state: string) => {
        const recipient = await worker.clients.get(clientId);
        if (connectedOwner.session === session)
          recipient?.postMessage({
            protocol: 'locho-notes-status-v1',
            id: connectedOwner.id,
            state,
          });
      };
      owner.unsubscribe = client.subscribeStatus(
        (status) => {
          void postStatus(status.state).catch(() => {});
        },
        {
          onError: () => {
            void postStatus('failed').catch(() => {});
          },
        },
      );
    }
    return { id: owner.id, label: owner.label };
  };
  // Serialize control commands for each browser-derived client ID, never a
  // page-provided tab identifier. Fetches remain concurrent and revision guarded.
  const previous = queues.get(clientId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(clientId, next);
  event.waitUntil(
    next
      .then(
        (value) => port.postMessage({ ok: true, ...value }),
        (error: unknown) => port.postMessage({ ok: false, reset: error instanceof OwnerReset }),
      )
      .finally(() => {
        port.close();
        if (queues.get(clientId) === next) queues.delete(clientId);
        if (connecting.get(clientId) === connectionAbort) connecting.delete(clientId);
      }),
  );
});

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== base.origin || !url.pathname.startsWith(gatewayPath)) return;
  event.respondWith(
    (async () => {
      const owner = owners.get(event.clientId);
      if (!owner?.session || event.request.headers.get(GATEWAY_HEADER) !== owner.id) {
        return new Response(null, {
          status: 409,
          headers: { 'Cache-Control': 'no-store', 'X-Locho-Notes-Reset': '1' },
        });
      }
      if (
        url.search ||
        event.request.mode === 'navigate' ||
        event.request.headers.get('Sec-Fetch-Site') === 'cross-site'
      )
        return gatewayError(400, 'request');
      if (
        event.request.headers.get('Origin') &&
        event.request.headers.get('Origin') !== base.origin
      )
        return gatewayError(400, 'origin');
      try {
        const path = `/${url.pathname.slice(gatewayPath.length)}`;
        return await owner.session.fetch(path, event.request);
      } catch {
        return gatewayError();
      }
    })(),
  );
});
