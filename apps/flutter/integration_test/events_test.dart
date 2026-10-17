import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:http/http.dart' as http;
import 'package:locho_notes/session.dart';
import 'package:locho_notes/main.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'packaged browser and Flutter live CRUD recovery and expiry',
    (tester) async {
      final storage = SecureCredentials();
      await storage.replace(null);
      final session = NotesSession(storage);
      final bob = NotesSession(SecureCredentials());
      final control = http.Client();
      Future<Map<String, dynamic>> command(String action) async {
        final response = await control
            .post(
              Uri.parse(
                '${const String.fromEnvironment('LOCHO_CONTROL')}/$action',
              ),
            )
            .timeout(const Duration(seconds: 40));
        expect(response.statusCode, 200);
        return jsonDecode(response.body) as Map<String, dynamic>;
      }

      Future<void> until(bool Function() check) async {
        final deadline = DateTime.now().add(const Duration(seconds: 40));
        while (!check() && DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(milliseconds: 100));
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(check(), true);
      }

      try {
        await tester.pumpWidget(NotesApp(session: session));
        await session.pair(const String.fromEnvironment('LOCHO_TICKET'));
        await session.login('alice@example.test', 'alice-local-demo-only');
        expect(session.live, 'live');
        await session.setRemember(true);
        await bob.pair(const String.fromEnvironment('LOCHO_TICKET'));
        await bob.login('bob@example.test', 'bob-local-demo-only');
        // Real production 30s heartbeat cadence: exceed two heartbeats and the old
        // 15s buffered deadline while both packaged applications remain live.
        await Future<void>.delayed(const Duration(seconds: 65));
        expect(session.live, 'live');
        await command('browser-live');
        final created = await command('browser-create');
        final title = created['title'] as String;
        await until(() => session.notes.any((n) => n['title'] == title));
        expect(bob.notes, isEmpty);
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('Title')),
          'Unsaved Flutter draft',
        );
        await tester.enterText(
          find.byKey(const ValueKey('Body')),
          'Keep my draft',
        );
        final id = session.notes.single['id'] as String;
        await session.save(title, 'Updated in Flutter', id);
        await command('browser-check-flutter');
        await command('events-pause');
        await until(() => session.live == 'reconnecting');
        await command('browser-edit-offline');
        expect(session.notes.single['body'], 'Updated in Flutter');
        await command('events-resume');
        await until(
          () =>
              session.live == 'live' &&
              session.notes.single['body'] ==
                  'Changed while Flutter events offline',
        );
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('Title')))
              .controller!
              .text,
          'Unsaved Flutter draft',
        );
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('Body')))
              .controller!
              .text,
          'Keep my draft',
        );
        session.suspend();
        await until(() => session.live == 'off');
        await command('browser-edit-suspended');
        await session.resume();
        expect(session.notes.single['body'], 'Changed while Flutter suspended');
        await command('browser-delete');
        await until(() => session.notes.isEmpty);
        await session.save('Created in Flutter', 'Native create', null);
        await command('browser-check-create');
        await session.remove(session.notes.single['id'] as String);
        await command('browser-check-delete');
        final status = await command('status');
        expect(status['eventStreams'], 3);
        await bob.logout();
        await until(() => bob.live == 'off');
        await session.logout();
        expect(session.message, 'Logged out.');
        expect(session.live, 'off');
        await session.reconnect();
        await session.login('alice@example.test', 'alice-local-demo-only');
        await session.setRemember(true);
        await command('events-expire');
        await until(() => session.phase == 'login');
        expect(session.notes, isEmpty);
        expect(session.live, 'off');
        expect(jsonDecode((await storage.read())!)['token'], isNull);
        debugPrint('NOTES_CROSS_PLATFORM_EVENTS_PASS');
      } finally {
        await command('events-resume');
        await session.close();
        await bob.close();
        await storage.replace(null);
        control.close();
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
