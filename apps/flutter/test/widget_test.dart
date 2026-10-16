import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:locho_notes/main.dart';
import 'package:locho_notes/session.dart';

class EmptyStorage implements Credentials {
  @override
  Future<String?> read() async => null;
  @override
  Future<void> replace(String? value) async {}
}

void main() {
  testWidgets('pairing defaults to memory only and obscures credential input', (
    tester,
  ) async {
    final session = NotesSession(EmptyStorage());
    await tester.pumpWidget(NotesApp(session: session));
    await tester.pumpAndSettle();
    expect(session.remember, false);
    final ticket = tester.widget<TextField>(
      find.byKey(const ValueKey('Attachment ticket')),
    );
    expect(ticket.obscureText, true);
    expect(find.text('Locho Notes'), findsOneWidget);
    await tester.tap(find.text('Forget homelab'));
    await tester.pumpAndSettle();
    expect(session.phase, 'unpaired');
  });
}
