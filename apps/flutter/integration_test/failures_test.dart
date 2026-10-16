import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:http/http.dart' as http;
import 'package:locho_notes/session.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real host restart upstream outage and lost mutation responses',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('Failure acceptance'))),
      );
      final storage = SecureCredentials();
      await storage.replace(null);
      final session = NotesSession(storage);
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

      try {
        await session.pair(const String.fromEnvironment('LOCHO_TICKET'));
        await session.login('alice@example.test', 'alice-local-demo-only');
        expect(session.phase, 'notes');
        final before = await command('status');
        await command('interrupt-POST');
        await session.save('Unknown outcome', 'Created', null);
        expect(session.message, contains('outcome unknown'));
        await session.refresh();
        expect(session.notes.length, 1);
        final id = session.notes.single['id'] as String;
        await command('interrupt-PATCH');
        await session.save('Unknown outcome', 'Edited', id);
        expect(session.message, contains('outcome unknown'));
        await session.refresh();
        expect(session.notes.single['body'], 'Edited');
        await command('interrupt-DELETE');
        await session.remove(id);
        expect(session.message, contains('outcome unknown'));
        await session.refresh();
        expect(session.notes, isEmpty);
        final after = await command('status');
        expect(after['mutations'] - before['mutations'], 3);
        expect(after['dropped'] - before['dropped'], 3);
        await command('upstream-stop');
        await session.refresh();
        expect(session.message, contains('Request failed'));
        await command('upstream-start');
        await session.refresh();
        expect(session.message, '');
        await command('host-stop');
        final deadline = DateTime.now().add(const Duration(seconds: 35));
        while (session.phase == 'notes' && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(session.phase, 'disconnected');
        await command('host-start');
        final recovery = DateTime.now().add(const Duration(seconds: 45));
        while (session.phase != 'notes' && DateTime.now().isBefore(recovery)) {
          if (session.phase == 'disconnected' &&
              !session.busy &&
              session.message.contains('validation failed')) {
            await session.reconnect();
            break;
          }
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(session.phase, 'notes');
        expect(session.user?['email'], 'alice@example.test');
      } finally {
        await command('upstream-start');
        await command('host-start');
        await session.close();
        await storage.replace(null);
        control.close();
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
