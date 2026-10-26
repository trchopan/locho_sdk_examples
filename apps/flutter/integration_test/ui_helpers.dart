import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

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

Future<void> reveal(WidgetTester tester, Finder target) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  final scrollable = find
      .descendant(of: find.byType(ListView), matching: find.byType(Scrollable))
      .first;
  // ListView lazily removes off-screen children on small phone/emulator displays.
  // Start at the top and scroll to build the target before resolving its element.
  tester.state<ScrollableState>(scrollable).position.jumpTo(0);
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(
    target,
    250,
    scrollable: scrollable,
    maxScrolls: 40,
  );
  await tester.pumpAndSettle();
}

Future<void> tap(WidgetTester tester, String text) async {
  final target = find.text(text);
  await reveal(tester, target);
  await tester.tap(target.last);
  await tester.pump();
}

Future<void> enter(WidgetTester tester, String key, String value) async {
  final target = find.byKey(ValueKey(key));
  await reveal(tester, target);
  await tester.enterText(target, value);
  await tester.pump();
}
