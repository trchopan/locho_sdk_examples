import 'dart:async';
import 'package:flutter/material.dart';
import 'session.dart';

void main() => runApp(NotesApp(session: NotesSession(SecureCredentials())));

class NotesApp extends StatelessWidget {
  final NotesSession session;
  const NotesApp({super.key, required this.session});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Locho Notes',
    theme: ThemeData(colorSchemeSeed: Colors.teal),
    home: NotesScreen(session: session),
  );
}

class NotesScreen extends StatefulWidget {
  final NotesSession session;
  const NotesScreen({super.key, required this.session});
  @override
  State<NotesScreen> createState() => _NotesScreenState();
}

class _NotesScreenState extends State<NotesScreen> with WidgetsBindingObserver {
  final ticket = TextEditingController(),
      email = TextEditingController(),
      password = TextEditingController(),
      title = TextEditingController(),
      body = TextEditingController();
  String? editing;
  int editorRevision = 0;
  NotesSession get s => widget.session;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    editorRevision = s.editorRevision;
    s.addListener(clearObsoleteEditor);
    unawaited(s.restore());
  }

  void clearObsoleteEditor() {
    if (editorRevision == s.editorRevision) return;
    editorRevision = s.editorRevision;
    editing = null;
    title.clear();
    body.clear();
    password.clear();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if ([
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.detached,
    ].contains(state)) {
      s.suspend();
    } else if (state == AppLifecycleState.resumed) {
      unawaited(s.resume());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    s.removeListener(clearObsoleteEditor);
    unawaited(s.close());
    for (final c in [ticket, email, password, title, body]) {
      c.dispose();
    }
    super.dispose();
  }

  Widget field(
    String name,
    TextEditingController controller, {
    bool secret = false,
    int lines = 1,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: TextField(
      key: ValueKey(name),
      controller: controller,
      obscureText: secret,
      autocorrect: !secret,
      enableSuggestions: !secret,
      maxLines: lines,
      decoration: InputDecoration(
        labelText: name,
        border: const OutlineInputBorder(),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: s,
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: const Text('Locho Notes')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('${s.phase} ${s.label}', key: const ValueKey('status')),
          const Text(
            'Foreground only. Remember is opt-in; passwords are never saved.',
          ),
          SwitchListTile(
            title: const Text('Remember this device'),
            value: s.remember,
            onChanged: (value) => unawaited(s.setRemember(value)),
          ),
          if (s.storageError.isNotEmpty) Text(s.storageError),
          if (s.storageBusy) const Text('Updating saved credentials…'),
          if (s.storageError.isNotEmpty)
            TextButton(
              onPressed: s.storageBusy ? null : () => unawaited(s.persist()),
              child: const Text('Retry storage'),
            ),
          field('Attachment ticket', ticket, secret: true),
          Wrap(
            children: [
              ElevatedButton(
                onPressed: s.busy
                    ? null
                    : () {
                        final value = ticket.text;
                        ticket.clear();
                        unawaited(s.pair(value));
                      },
                child: const Text('Pair'),
              ),
              TextButton(
                onPressed: s.busy ? null : () => unawaited(s.reconnect()),
                child: const Text('Reconnect'),
              ),
              TextButton(
                onPressed: () => s.disconnect(),
                child: const Text('Disconnect'),
              ),
              TextButton(
                onPressed: () {
                  title.clear();
                  body.clear();
                  password.clear();
                  editing = null;
                  unawaited(s.forget());
                },
                child: const Text('Forget homelab'),
              ),
              TextButton(
                onPressed: s.busy ? null : () => unawaited(s.logout()),
                child: const Text('Logout'),
              ),
            ],
          ),
          if (s.busy) const LinearProgressIndicator(),
          if (s.message.isNotEmpty)
            Text(s.message, key: const ValueKey('message')),
          if (s.phase == 'login') ...[
            field('Email', email),
            field('Password', password, secret: true),
            ElevatedButton(
              onPressed: s.busy
                  ? null
                  : () {
                      final value = password.text;
                      password.clear();
                      unawaited(s.login(email.text, value));
                    },
              child: const Text('Login'),
            ),
          ],
          if (s.phase == 'notes') ...[
            Text('Notes for ${s.user?['email']}'),
            Text('Live updates: ${s.live}', key: const ValueKey('live-status')),
            TextButton(
              onPressed: s.busy ? null : () => unawaited(s.refresh()),
              child: const Text('Refresh notes'),
            ),
            field('Title', title),
            field('Body', body, lines: 3),
            ElevatedButton(
              onPressed: s.busy
                  ? null
                  : () => unawaited(s.save(title.text, body.text, editing)),
              child: Text(editing == null ? 'Create note' : 'Save changes'),
            ),
            TextButton(
              onPressed: () => setState(() {
                editing = null;
                title.clear();
                body.clear();
              }),
              child: const Text('Clear editor'),
            ),
            for (final note in s.notes)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(note['title'] as String),
                      Text(note['body'] as String),
                      Wrap(
                        children: [
                          TextButton(
                            onPressed: s.busy
                                ? null
                                : () => setState(() {
                                    editing = note['id'];
                                    title.text = note['title'];
                                    body.text = note['body'];
                                  }),
                            child: const Text('Edit'),
                          ),
                          TextButton(
                            onPressed: s.busy
                                ? null
                                : () =>
                                      unawaited(s.remove(note['id'] as String)),
                            child: const Text('Delete'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ],
      ),
    ),
  );
}
