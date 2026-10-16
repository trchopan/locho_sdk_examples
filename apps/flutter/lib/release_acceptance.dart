import 'package:flutter/material.dart';
import 'acceptance.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    const MaterialApp(
      home: Scaffold(body: Center(child: Text('Notes release acceptance'))),
    ),
  );
  run();
}

Future<void> run() async {
  try {
    await acceptNotes(const String.fromEnvironment('LOCHO_TICKET'));
    debugPrint('NOTES_ACCEPTANCE_PASS');
  } catch (_) {
    debugPrint('NOTES_ACCEPTANCE_FAIL');
  }
}
