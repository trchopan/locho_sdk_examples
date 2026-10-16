import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:locho_notes/acceptance.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('packaged notes CRUD secure restoration and lifecycle', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Text('Notes acceptance'))),
    );
    await acceptNotes(const String.fromEnvironment('LOCHO_TICKET'));
    await tester.pumpAndSettle();
  });
}
