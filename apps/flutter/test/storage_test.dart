import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:locho_notes/session.dart';

class Memory implements Credentials {
  String? value;
  bool fail = false;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> replace(String? next) async {
    if (fail) throw StateError('storage');
    value = next;
  }
}

void main() {
  test(
    'failed deletion is visible and never claims successful forgetting',
    () async {
      final storage = Memory()..fail = true;
      final session = NotesSession(storage);
      await session.forget();
      expect(session.phase, 'unpaired');
      expect(session.storageError, contains('Storage failed'));
    },
  );
  test('late storage read cannot restore after forget', () async {
    final pending = Completer<String?>();
    final session = NotesSession(Delayed(pending));
    final restoring = session.restore();
    await session.forget();
    pending.complete('{"ticket":"obsolete"}');
    await restoring;
    expect(session.phase, 'unpaired');
    expect(session.remember, false);
  });
}

class Delayed implements Credentials {
  final Completer<String?> pending;
  Delayed(this.pending);
  @override
  Future<String?> read() => pending.future;
  @override
  Future<void> replace(String? value) async {}
}
