/** Application-specific contract, not a browser-compatible cookie jar. */
export const SESSION_COOKIE = 'locho_notes_session';
export const COOKIE_PATH = '/browser/';
const MAX_LIFETIME_MS = 30 * 86400 * 1000;

export class CookieSession {
  private value?: string;
  private expiresAt = 0;
  constructor(private now: () => number = Date.now) {}
  clear() {
    this.value = undefined;
    this.expiresAt = 0;
  }
  header(path: string): string | undefined {
    if (!path.startsWith(COOKIE_PATH)) throw new Error('Invalid cookie scope');
    if (this.now() >= this.expiresAt) this.clear();
    return this.value ? `${SESSION_COOKIE}=${this.value}` : undefined;
  }
  accept(headers: ReadonlyArray<readonly [string, string]>) {
    const fields = headers.filter(
      ([name, value]) =>
        name.toLowerCase() === 'set-cookie' && value.split('=', 1)[0].trim() === SESSION_COOKIE,
    );
    if (fields.length === 0) return;
    // Reject ambiguous updates atomically, including two differently scoped values.
    this.clear();
    if (fields.length !== 1 || fields[0][1].length > 2048)
      throw new Error('Invalid session cookie');
    const [pair, ...attributes] = fields[0][1].split(';').map((part) => part.trim());
    const value = pair.slice(SESSION_COOKIE.length + 1);
    const parsed = new Map<string, string>();
    for (const attribute of attributes) {
      const separator = attribute.indexOf('=');
      const name = (separator < 0 ? attribute : attribute.slice(0, separator)).toLowerCase();
      const content = separator < 0 ? '' : attribute.slice(separator + 1);
      if (
        !['path', 'expires', 'max-age', 'secure', 'httponly', 'samesite'].includes(name) ||
        parsed.has(name)
      )
        throw new Error('Invalid session attributes');
      parsed.set(name, content);
    }
    if (
      parsed.get('path') !== COOKIE_PATH ||
      parsed.get('secure') !== '' ||
      parsed.get('httponly') !== '' ||
      parsed.get('samesite')?.toLowerCase() !== 'strict'
    )
      throw new Error('Invalid session scope');
    let expiry = Number.NaN;
    if (parsed.has('expires')) {
      expiry = Date.parse(parsed.get('expires') ?? '');
      if (!Number.isFinite(expiry)) throw new Error('Invalid session expiry');
    }
    if (parsed.has('max-age')) {
      const age = parsed.get('max-age') ?? '';
      if (!/^-?\d+$/.test(age) || !Number.isSafeInteger(Number(age)))
        throw new Error('Invalid session age');
      expiry = this.now() + Math.min(Number(age) * 1000, MAX_LIFETIME_MS);
    }
    if (!Number.isFinite(expiry)) throw new Error('Missing session expiry');
    if (expiry <= this.now()) return;
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid session value');
    this.value = value;
    this.expiresAt = Math.min(expiry, this.now() + MAX_LIFETIME_MS);
  }
}
