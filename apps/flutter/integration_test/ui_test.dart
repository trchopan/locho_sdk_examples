import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:locho_notes/main.dart';
import 'package:locho_notes/session.dart';

Future<void> until(WidgetTester tester, bool Function() ready) async {
  final deadline = DateTime.now().add(const Duration(seconds: 45));
  while (!ready()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('UI transition timeout');
    }
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pumpAndSettle();
}

Future<void> tap(WidgetTester tester, String text) async {
  final target = find.text(text).last;
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pump();
}

Future<void> enter(WidgetTester tester, String key, String value) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.enterText(target, value);
  await tester.pump();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'tap-driven packaged notes pairing login CRUD logout and forget',
    (tester) async {
      final storage = SecureCredentials();
      await storage.replace(null);
      final session = NotesSession(storage);
      await tester.pumpWidget(NotesApp(session: session));
      await tester.pumpAndSettle();
      try {
        await enter(
          tester,
          'Attachment ticket',
          const String.fromEnvironment('LOCHO_TICKET'),
        );
        await tap(tester, 'Pair');
        await until(tester, () => !session.busy);
        expect(session.phase, 'login');
        expect(
          tester
              .widget<TextField>(
                find.byKey(const ValueKey('Attachment ticket')),
              )
              .controller!
              .text,
          '',
        );
        await enter(tester, 'Email', 'alice@example.test');
        await enter(tester, 'Password', 'alice-local-demo-only');
        await tap(tester, 'Login');
        await until(tester, () => !session.busy);
        expect(session.phase, 'notes');
        await enter(tester, 'Title', 'Tapped private note');
        await enter(tester, 'Body', 'Tapped Unicode 🌍');
        await tap(tester, 'Create note');
        await until(tester, () => !session.busy);
        expect(session.notes.single['title'], 'Tapped private note');
        await tap(tester, 'Edit');
        await enter(tester, 'Body', 'Tapped edit');
        await tap(tester, 'Save changes');
        await until(tester, () => !session.busy);
        expect(session.notes.single['body'], 'Tapped edit');
        await tap(tester, 'Delete');
        await until(tester, () => !session.busy);
        expect(session.notes, isEmpty);
        await tap(tester, 'Logout');
        await until(tester, () => !session.busy);
        expect(session.message, 'Logged out.');
        await tap(tester, 'Forget homelab');
        await tester.pumpAndSettle();
        expect(session.phase, 'unpaired');
        expect(await storage.read(), isNull);
      } finally {
        await session.close();
        await storage.replace(null);
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      }
    },
  );
}
