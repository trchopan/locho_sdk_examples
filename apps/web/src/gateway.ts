import { CookieSession } from './cookie-session';

export const GATEWAY = '__locho_notes__/';
export const GATEWAY_HEADER = 'x-locho-notes-owner';
type RequestOptions = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: Uint8Array;
  signal: AbortSignal;
};
export interface MetadataClient {
  fetchWithMetadata(
    path: string,
    options: RequestOptions & { timeoutMs: number },
  ): Promise<Metadata>;
  fetchStreamWithMetadata(
    path: string,
    options: RequestOptions & { setupTimeoutMs: number; idleTimeoutMs: number },
  ): Promise<Metadata>;
  close(): Promise<void>;
}
type Metadata = { response: Response; upstreamHeaders: ReadonlyArray<readonly [string, string]> };

export function gatewayError(
  status = 503,
  rejection?: 'origin' | 'request' | 'credentials' | 'content-type',
) {
  return Response.json(
    { error: { code: 'gateway_unavailable', message: 'Pair again or reconnect.' } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(status === 503 ? { 'X-Locho-Notes-Transport-Error': '1' } : {}),
        ...(rejection ? { 'X-Locho-Notes-Rejection': rejection } : {}),
      },
    },
  );
}

/** Exact route mapping prevents the service worker becoming an arbitrary proxy. */
export function upstreamPath(path: string, method: string): string {
  if (path === '/health' && method === 'GET') return path;
  if (['/auth/login', '/auth/logout'].includes(path) && method === 'POST') return `/browser${path}`;
  if (['/api/me', '/api/events'].includes(path) && method === 'GET') return `/browser${path}`;
  if (path === '/api/notes' && ['GET', 'POST'].includes(method)) return `/browser${path}`;
  if (/^\/api\/notes\/[A-Za-z0-9-]{1,128}$/.test(path) && ['PATCH', 'DELETE'].includes(method))
    return `/browser${path}`;
  throw new Error('Invalid gateway operation');
}

async function requestBody(request: Request) {
  if (!request.body) {
    // Firefox can expose a null Request.body in a service worker even for a POST.
    // Its native Blob reader still works; inspect size before making a JS byte
    // copy. Native browser request/Blob buffering is outside our JS budget.
    const blob = await request.blob();
    if (blob.size > 64 * 1024) throw new Error('Gateway body limit');
    return blob.size ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error('Gateway body limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** One owner per tab/pairing. close() invalidates all in-flight metadata updates. */
export class GatewaySession {
  private cookie = new CookieSession();
  private abort = new AbortController();
  private revision = 0;
  private loginPending = false;
  constructor(private client: MetadataClient) {}
  async close() {
    this.revision++;
    this.cookie.clear();
    this.abort.abort();
    await this.client.close();
  }
  async fetch(path: string, request: Request): Promise<Response> {
    const upstream = upstreamPath(path, request.method);
    if (this.abort.signal.aborted) return gatewayError();
    if (request.headers.has('Authorization') || request.headers.has('Cookie'))
      return gatewayError(400, 'credentials');
    const login = path === '/auth/login';
    const logout = path === '/auth/logout';
    if (login && this.loginPending) return gatewayError(409);
    const cookie = this.cookie.header(upstream === '/health' ? '/browser/' : upstream);
    if (login || logout) {
      this.revision++;
      this.cookie.clear();
    }
    const revision = this.revision;
    if (login) this.loginPending = true;
    // Logout carries the captured cookie, but no later request can reuse it.
    const headers: Record<string, string> = { 'X-Locho-Session-Mode': 'cookie' };
    if (cookie && !login && upstream !== '/health') headers.Cookie = cookie;
    if (['POST', 'PATCH'].includes(request.method) && !logout) {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
        if (login) this.loginPending = false;
        return gatewayError(400, 'content-type');
      }
      headers['Content-Type'] = 'application/json';
    }
    const signal = AbortSignal.any([request.signal, this.abort.signal]);
    try {
      const options = {
        method: request.method as RequestOptions['method'],
        headers,
        body: await requestBody(request),
        signal,
      };
      const streaming = path === '/api/events';
      const result = streaming
        ? await this.client.fetchStreamWithMetadata(upstream, {
            ...options,
            setupTimeoutMs: 15000,
            idleTimeoutMs: 75000,
          })
        : await this.client.fetchWithMetadata(upstream, { ...options, timeoutMs: 15000 });
      try {
        if (signal.aborted || revision !== this.revision)
          throw new Error('Obsolete gateway response');
        if (upstream !== '/health') this.cookie.accept(result.upstreamHeaders);
        if (result.response.status === 401 || logout) {
          this.cookie.clear();
          this.revision++;
        }
        if (login && result.response.ok && !this.cookie.header(upstream))
          throw new Error('Missing session metadata');
        if (result.response.status >= 300 && result.response.status < 400)
          throw new Error('Redirect rejected');
        const safe = new Headers({ 'Cache-Control': 'no-store' });
        for (const name of ['content-type', 'retry-after']) {
          const value = result.response.headers.get(name);
          if (value) safe.set(name, value);
        }
        // No clone/tee: the original body retains pull/cancel ownership.
        return new Response(result.response.body, {
          status: result.response.status,
          headers: safe,
        });
      } catch (error) {
        await result.response.body?.cancel().catch(() => {});
        throw error;
      }
    } finally {
      if (login) this.loginPending = false;
      if (logout) this.cookie.clear();
    }
  }
}
