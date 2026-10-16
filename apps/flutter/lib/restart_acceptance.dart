import 'package:flutter/material.dart';
import 'session.dart';

/// Synthetic fixture entry point. Restarted by the harness without rebuilding.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    const MaterialApp(home: Scaffold(body: Text('Process restart acceptance'))),
  );
  run();
}

Future<void> run() async {
  final store = SecureCredentials();
  final session = NotesSession(store);
  try {
    if (await store.read() == null) {
      await session.pair(const String.fromEnvironment('LOCHO_TICKET'));
      await session.setRemember(true);
      await session.login('alice@example.test', 'alice-local-demo-only');
      if (session.phase != 'notes' || session.storageError.isNotEmpty) {
        throw StateError('seed');
      }
      await session.close();
      debugPrint('NOTES_RESTART_SEEDED');
    } else {
      await session.restore();
      if (session.phase != 'notes' ||
          session.user?['email'] != 'alice@example.test') {
        throw StateError('restore');
      }
      await session.forget();
      await session.close();
      if (await store.read() != null) throw StateError('forget');
      debugPrint('NOTES_RESTART_PASS');
    }
  } catch (_) {
    await session.close();
    debugPrint('NOTES_RESTART_FAIL');
  }
}
