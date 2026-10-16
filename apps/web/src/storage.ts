import type { Auth } from './session';

export type SavedSession = { version: 1; key: string; ticket: string; auth?: Auth };
export interface CredentialStore {
  read(): Promise<SavedSession | undefined>;
  replace(record: SavedSession | undefined): Promise<void>;
}

/** One selected attachment, keyed by full host/service/type, in an atomic transaction. */
export class IndexedCredentials implements CredentialStore {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let failed = false;
      const timer = setTimeout(() => { failed = true; reject(new Error('Storage timeout')); }, 5000);
      let request: IDBOpenDBRequest;
      try { request = indexedDB.open('locho-notes-v1', 1); }
      catch { clearTimeout(timer); reject(new Error('Storage unavailable')); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('credentials', { keyPath: 'key' });
      request.onerror = () => { clearTimeout(timer); reject(new Error('Storage unavailable')); };
      request.onblocked = () => { clearTimeout(timer); failed = true; reject(new Error('Storage blocked')); };
      request.onsuccess = () => { clearTimeout(timer); if (failed) request.result.close(); else resolve(request.result); };
    });
  }
  async read(): Promise<SavedSession | undefined> {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('credentials', 'readonly');
        const request = tx.objectStore('credentials').getAll();
        tx.oncomplete = () => {
          const rows = request.result;
          if (rows.length > 1) { reject(new Error('Invalid stored record')); return; }
          const row = rows[0];
          if (row !== undefined && (row.version !== 1 || typeof row.key !== 'string' || typeof row.ticket !== 'string'
            || row.ticket.length > 8192 || (row.auth !== undefined && (typeof row.auth.token !== 'string'
              || row.auth.token.length > 4096 || typeof row.auth.expiresAt !== 'string'
              || typeof row.auth.user?.id !== 'string' || typeof row.auth.user?.email !== 'string')))) {
            reject(new Error('Invalid stored record')); return;
          }
          resolve(row);
        };
        tx.onerror = tx.onabort = () => reject(new Error('Storage read failed'));
      });
    } finally { db.close(); }
  }
  async replace(record: SavedSession | undefined): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('credentials', 'readwrite');
        const store = tx.objectStore('credentials');
        store.clear();
        if (record) store.put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error('Storage write failed'));
      });
    } finally { db.close(); }
  }
}
