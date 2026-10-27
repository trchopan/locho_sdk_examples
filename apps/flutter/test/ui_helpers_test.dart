import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import '../integration_test/ui_helpers.dart' as ui;

void main() {
  testWidgets(
    'acceptance helpers reveal lazy children and return to top controls',
    (tester) async {
      var deleted = false;
      var loggedOut = false;
      final body = TextEditingController();
      addTearDown(body.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListView(
              children: [
                TextButton(
                  onPressed: () => loggedOut = true,
                  child: const Text('Logout'),
                ),
                for (var i = 0; i < 40; i++)
                  SizedBox(height: 100, child: Text('Row $i')),
                TextField(key: const ValueKey('Body'), controller: body),
                TextButton(
                  onPressed: () => deleted = true,
                  child: const Text('Delete'),
                ),
              ],
            ),
          ),
        ),
      );
      expect(find.text('Delete'), findsNothing);
      await ui.tap(tester, 'Delete');
      expect(deleted, true);
      await ui.enter(tester, 'Body', 'Synthetic text');
      expect(body.text, 'Synthetic text');
      await ui.tap(tester, 'Logout');
      expect(loggedOut, true);
    },
  );
}
