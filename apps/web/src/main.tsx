import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { LochoClient, LochoTicket } from 'locho_web';
import { Session, type Note } from './session';
import { IndexedCredentials } from './storage';
import './style.css';

const session = new Session(async (text) => {
  const ticket = await LochoTicket.parse(text);
  const metadata = ticket.metadata;
  if (metadata.serviceType !== 'tcp') throw new Error('TCP ticket required');
  return { key: `${metadata.hostId}/${metadata.service}/${metadata.serviceType}`, label: `${metadata.service} · ${metadata.hostId.slice(0, 12)}`, export: () => ticket.export(), connect: (signal) => LochoClient.connect({ ticket, signal, http: { authority: 'sample-api' } }) };
}, new IndexedCredentials());
window.addEventListener('pagehide', () => session.suspend());
window.addEventListener('pageshow', () => { void session.resume(); });
void session.restore();

function App() {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [ticket, setTicket] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string>();
  useEffect(() => { setTitle(''); setBody(''); setEditing(undefined); setPassword(''); }, [state.user?.id, state.label]);
  const edit = (note: Note) => { setEditing(note.id); setTitle(note.title); setBody(note.body); };
  return <main>
    <h1>Locho Notes</h1><p>Private notes through your Locho TCP service.</p>
    <p role="status">{state.phase}{state.label && ` · ${state.label}`}</p>
    <p>{state.remember ? 'Remember enabled. Saved credentials are revalidated before notes are restored.' : 'Memory-only pairing and login. Nothing is remembered after a fresh page load.'}</p>
    <label><input type="checkbox" checked={state.remember} onChange={(e) => void session.setRemember(e.target.checked)} />Remember this device</label>
    {state.storageBusy && <p>Updating saved credentials…</p>}
    {state.storageError && <p role="alert">{state.storageError} <button onClick={() => void session.setRemember(state.remember)}>Retry storage</button></p>}
    <form onSubmit={(e) => { e.preventDefault(); const input = ticket; setTicket(''); void session.pair(input); }}>
      <label>Attachment ticket<input type="password" autoComplete="off" value={ticket} onChange={(e) => setTicket(e.target.value)} required /></label>
      <button disabled={state.busy}>Pair</button>
    </form>
    <nav><button onClick={() => void session.reconnect()} disabled={state.busy || state.phase !== 'disconnected'}>Reconnect</button>
      <button onClick={() => session.disconnect()}>Disconnect</button>
      <button onClick={() => { void session.forget(); setTicket(''); setPassword(''); setTitle(''); setBody(''); setEditing(undefined); }}>Forget homelab</button>
      <button onClick={() => { setPassword(''); void session.logout(); }} disabled={state.busy}>Logout</button></nav>
    {state.message && <p role="alert">{state.message}</p>}
    {state.phase === 'login' && <form onSubmit={(e) => { e.preventDefault(); const value = password; setPassword(''); void session.login(email, value); }}>
      <h2>Login</h2><label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Password<input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <button disabled={state.busy}>Login</button>
    </form>}
    {state.phase === 'notes' && <section><h2>Notes for {state.user?.email}</h2>
      <p data-testid="live-status">Live updates: {state.live}</p>
      <button disabled={state.busy} onClick={() => void session.refresh()}>Refresh notes</button>
      <form onSubmit={(e) => { e.preventDefault(); void session.save(title, body, editing); }}>
        <h3>{editing ? 'Edit note' : 'New note'}</h3>
        <label htmlFor="note-title">Title</label><input id="note-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <label htmlFor="note-body">Body</label><textarea id="note-body" value={body} onChange={(e) => setBody(e.target.value)} />
        <button disabled={state.busy}>{editing ? 'Save changes' : 'Create note'}</button>
        <button type="button" onClick={() => { setEditing(undefined); setTitle(''); setBody(''); }}>Clear editor</button>
      </form>
      <ul>{state.notes.map((note) => <li key={note.id}><h3>{note.title}</h3><pre>{note.body}</pre>
        <button disabled={state.busy} onClick={() => edit(note)}>Edit {note.title}</button>
        <button disabled={state.busy} onClick={() => void session.remove(note.id)}>Delete {note.title}</button></li>)}</ul>
    </section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
