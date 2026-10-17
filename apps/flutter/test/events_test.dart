import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:locho_notes/events.dart';
import 'package:locho_notes/session.dart';
import 'package:locho_notes/transport.dart';
import 'ownership_test.dart' show Ticket, Client, Memory;

List<int> event() => utf8.encode(
  'event: note.changed\ndata: {"operation":"updated","noteId":"note"}\n\n',
);
Future<void> until(bool Function() condition) async {
  for (var i = 0; i < 100; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  fail('Condition not reached');
}

class EventClient extends http.BaseClient {
  final Future<http.StreamedResponse> Function() open;
  final void Function() closing;
  EventClient(this.open, this.closing);
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    expect(request.followRedirects, false);
    expect(request.headers['Authorization'], 'Bearer synthetic-token');
    return open();
  }

  @override
  void close() => closing();
}

class EventsFixture {
  final storage = Memory();
  final streams = <StreamController<List<int>>>[];
  final calls = <String>[];
  int lists = 0, writes = 0, cancelled = 0;
  bool valid = true;
  Future<void>? hold;
  late final session = NotesSession(
    storage,
    dependencies: SessionDependencies(
      parse: (text) async => Ticket(text),
      create: () async => Client(),
      httpClient: () => MockClient((request) async {
        final path = request.url.path;
        calls.add(path);
        if (path == '/health') {
          return http.Response('{"service":"locho-notes","apiVersion":1}', 200);
        }
        if (path == '/auth/login') {
          return http.Response(
            '{"token":"synthetic-token","user":{"id":"alice","email":"alice@example.test"}}',
            200,
          );
        }
        if (!valid) return http.Response('', 401);
        if (path == '/api/me') {
          return http.Response('{"user":{"id":"alice"}}', 200);
        }
        if (request.method == 'POST') {
          writes++;
          throw StateError('lost response');
        }
        lists++;
        await hold;
        return http.Response('{"notes":[]}', 200);
      }),
      eventClient: () {
        StreamController<List<int>>? controller;
        return EventClient(
          () async {
            calls.add('/api/events');
            controller = StreamController<List<int>>(
              onCancel: () {
                cancelled++;
              },
            );
            streams.add(controller!);
            return http.StreamedResponse(
              controller!.stream,
              valid ? 200 : 401,
              headers: {'content-type': 'text/event-stream'},
            );
          },
          () {
            unawaited(controller?.close());
          },
        );
      },
      eventRetryBase: const Duration(milliseconds: 1),
      eventRandom: () => 0,
      cleanupTimeout: const Duration(milliseconds: 100),
    ),
  );
  Future<void> login() async {
    await session.pair('a');
    await session.login('a', 'b');
  }
}

void main() {
  test(
    'late admission after setup timeout is cancelled without resurrection',
    () async {
      final admission = Completer<http.StreamedResponse>();
      var cancelled = 0, refreshes = 0;
      final watch = NoteEventWatch(
        createClient: () => EventClient(() => admission.future, () {}),
        uri: Uri.parse('http://localhost/api/events'),
        token: 'synthetic-token',
        validate: () async {},
        unauthorized: () async {},
        refresh: () {
          refreshes++;
        },
        state: (_) {},
        setupTimeout: const Duration(milliseconds: 10),
        idleTimeout: const Duration(seconds: 1),
        retryBase: const Duration(seconds: 30),
      );
      await watch.start();
      await watch.stop();
      admission.complete(
        http.StreamedResponse(
          StreamController<List<int>>(
            onCancel: () {
              cancelled++;
            },
          ).stream,
          200,
        ),
      );
      await until(() => cancelled == 1);
      expect(refreshes, 0);
    },
  );
  test(
    'idle deadline cancels reader and recovery can be stopped during backoff',
    () async {
      var cancelled = 0;
      final states = <String>[];
      final controller = StreamController<List<int>>(
        onCancel: () {
          cancelled++;
        },
      );
      final watch = NoteEventWatch(
        createClient: () => EventClient(
          () async => http.StreamedResponse(
            controller.stream,
            200,
            headers: {'content-type': 'text/event-stream'},
          ),
          () {},
        ),
        uri: Uri.parse('http://localhost/api/events'),
        token: 'synthetic-token',
        validate: () async {},
        unauthorized: () async {},
        refresh: () {},
        state: states.add,
        setupTimeout: const Duration(seconds: 1),
        idleTimeout: const Duration(milliseconds: 10),
        retryBase: const Duration(seconds: 30),
      );
      await watch.start();
      await until(() => cancelled == 1);
      await until(() => states.last == 'reconnecting');
      await watch.stop();
    },
  );
  test(
    'split UTF-8 CR/LF comments multiline data unknown events and incomplete EOF',
    () {
      final changes = <Map<String, dynamic>>[];
      final parser = NoteEventParser(changes.add);
      final bytes = utf8.encode(
        ': connected\r\n\r\nevent: other\ndata: ignored\n\nid: no-replay\nretry: 0\nevent: note.changed\rdata: {"operation":"created",\rdata: "noteId":"🌍"}\r\r',
      );
      for (final byte in bytes) {
        parser.add([byte]);
      }
      parser.add(utf8.encode('event: note.changed\ndata: incomplete'));
      parser.end();
      expect(changes, [
        {'operation': 'created', 'noteId': '🌍'},
      ]);
    },
  );
  test(
    'malformed UTF-8/schema and unterminated or repeated fields fail bounded',
    () {
      for (final value in [
        'data: ${'x' * 4096}',
        'data:\n' * 1000,
        'event: note.changed\ndata: invalid\n\n',
        'event: note.changed\ndata: {"operation":"other","noteId":"x"}\n\n',
        'event: note.changed\ndata: {"operation":"created","noteId":"x","token":"bad"}\n\n',
      ]) {
        expect(
          () => NoteEventParser((_) {}).add(utf8.encode(value)),
          throwsFormatException,
        );
      }
      expect(() => NoteEventParser((_) {}).add([255]), throwsFormatException);
      final partial = NoteEventParser((_) {})..add([240]);
      expect(partial.end, throwsFormatException);
    },
  );
  test(
    'subscribes before list and coalesces burst with dirty follow-up',
    () async {
      final f = EventsFixture();
      try {
        await f.login();
        expect(
          f.calls.indexOf('/api/events'),
          lessThan(f.calls.indexOf('/api/notes')),
        );
        final held = Completer<void>();
        f.hold = held.future;
        f.streams.first.add(
          List.generate(20, (_) => event()).expand((v) => v).toList(),
        );
        await until(() => f.lists == 2);
        f.streams.first.add(event());
        await Future<void>.delayed(const Duration(milliseconds: 2));
        expect(f.lists, 2);
        f.hold = null;
        held.complete();
        await until(() => f.lists == 3);
        expect(f.lists, 3);
      } finally {
        await f.session.close();
      }
    },
  );
  test(
    'reconnect validates health/me then subscribes/refreshes without replay or message loss',
    () async {
      final f = EventsFixture();
      try {
        await f.login();
        await f.session.save('title', 'body', null);
        expect(f.session.message, contains('outcome unknown'));
        final offset = f.calls.length;
        await f.streams.first.close();
        await until(() => f.streams.length == 2 && f.lists == 2);
        expect(f.calls.sublist(offset), [
          '/health',
          '/api/me',
          '/api/events',
          '/api/notes',
        ]);
        expect(f.writes, 1);
        expect(f.session.message, contains('outcome unknown'));
      } finally {
        await f.session.close();
      }
    },
  );
  test(
    'suspend/resume, expiry during fetch and stale data cannot resurrect auth',
    () async {
      final f = EventsFixture();
      try {
        await f.login();
        await f.session.setRemember(true);
        f.session.suspend();
        await until(() => f.cancelled == 1);
        await f.session.resume();
        expect(f.streams.length, 2);
        final held = Completer<void>();
        f.hold = held.future;
        f.streams.last.add(event());
        await until(() => f.lists == 3);
        f.valid = false;
        await f.streams.last.close();
        await until(() => f.session.phase == 'login');
        f.hold = null;
        held.complete();
        await Future<void>.delayed(const Duration(milliseconds: 2));
        expect(f.session.notes, isEmpty);
        expect(f.session.live, 'off');
        expect(jsonDecode(f.storage.record!)['token'], isNull);
      } finally {
        await f.session.close();
      }
    },
  );
  test(
    '429 Retry-After prevents spin and stop cancels the retry timer',
    () async {
      var admissions = 0;
      final watch = NoteEventWatch(
        createClient: () => EventClient(() async {
          admissions++;
          return http.StreamedResponse(
            const Stream.empty(),
            429,
            headers: {'retry-after': '30'},
          );
        }, () {}),
        uri: Uri.parse('http://localhost/api/events'),
        token: 'synthetic-token',
        validate: () async {},
        unauthorized: () async {},
        refresh: () {},
        state: (_) {},
        setupTimeout: const Duration(seconds: 1),
        idleTimeout: const Duration(seconds: 1),
        retryBase: const Duration(milliseconds: 1),
      );
      await watch.start();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(admissions, 1);
      await watch.stop();
      expect(admissions, 1);
    },
  );
}
