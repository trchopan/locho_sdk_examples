import 'session.dart';
import 'package:flutter/foundation.dart';

/// Synthetic fixture acceptance, invoked only by test entry points.
Future<void> acceptNotes(String ticket) async {
  void check(bool condition) {
    if (!condition) throw StateError('acceptance');
  }

  final storage = SecureCredentials();
  await storage.replace(null);
  final sessions = <NotesSession>[];
  NotesSession create() {
    final session = NotesSession(storage);
    sessions.add(session);
    return session;
  }

  try {
    debugPrint('NOTES_STAGE_PAIR');
    final session = create();
    await session.pair(ticket);
    check(session.phase == 'login');
    await session.setRemember(true);
    await session.login('alice@example.test', 'alice-local-demo-only');
    debugPrint('NOTES_STAGE_CRUD');
    check(session.phase == 'notes');
    await session.save('Flutter private', 'Unicode 🌍', null);
    check(session.notes.length == 1);
    final id = session.notes.single['id'] as String;
    final bob = create();
    await bob.pair(ticket);
    await bob.login('bob@example.test', 'bob-local-demo-only');
    check(bob.notes.isEmpty);
    bob.disconnect();
    await session.save('Flutter private', 'Edited', id);
    check(session.notes.single['body'] == 'Edited');
    session.suspend();
    debugPrint('NOTES_STAGE_RESUME');
    await session.resume();
    check(session.phase == 'notes');
    session.disconnect();
    final restored = create();
    debugPrint('NOTES_STAGE_RESTORE');
    await restored.restore();
    check(restored.phase == 'notes');
    await restored.setRemember(false);
    check(await storage.read() == null);
    check(restored.phase == 'notes');
    await restored.setRemember(true);
    await restored.remove(id);
    check(restored.notes.isEmpty);
    await restored.logout();
    debugPrint('NOTES_STAGE_LOGOUT');
    check(restored.message == 'Logged out.');
    final loggedOut = create();
    await loggedOut.restore();
    check(loggedOut.phase == 'login');
    await loggedOut.forget();
    check(await storage.read() == null);
  } finally {
    for (final session in sessions) {
      session.disconnect();
    }
    await storage.replace(null);
  }
}
