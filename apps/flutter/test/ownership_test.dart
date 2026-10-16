import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:locho_flutter/locho_flutter.dart';
import 'package:locho_notes/session.dart';
import 'package:locho_notes/transport.dart';
import 'package:locho_notes/main.dart';

class Ticket implements Pairing {
  final String name;
  Ticket([this.name = 'a']);
  @override
  String get hostId => name.padRight(64, '0');
  @override
  String get service => 'api';
  @override
  String get serviceType => 'tcp';
  @override
  Future<String> export() async => name;
}

class Memory implements Credentials {
  String? record;
  bool fail = false;
  Future<void> Function(String?)? writing;
  @override
  Future<String?> read() async => record;
  @override
  Future<void> replace(String? value) async {
    await writing?.call(value);
    if (fail) throw StateError('storage');
    record = value;
  }
}

class Link implements Attachment {
  final controller = StreamController<LochoState>.broadcast(sync: true);
  @override
  Uri get httpBaseUri => Uri.parse('http://127.0.0.1:1234');
  @override
  Stream<LochoState> get states => controller.stream;
}

class Client implements TunnelClient {
  int closes = 0;
  final link = Link();
  Future<Attachment> Function()? attaching;
  bool failClose = false;
  Future<void>? closing;
  @override
  Future<Attachment> attach(Pairing ticket) async =>
      attaching == null ? link : await attaching!();
  @override
  Future<void> close() async {
    closes++;
    await closing;
    if (failClose) throw StateError('cleanup');
  }
}

class Fixture {
  final storage = Memory();
  final clients = <Client>[];
  final requests = <http.Request>[];
  Future<Pairing> Function(String)? parse;
  Future<TunnelClient> Function()? create;
  Future<http.Response> Function(http.Request)? handle;
  late final session = NotesSession(
    storage,
    dependencies: SessionDependencies(
      parse: (text) => parse?.call(text) ?? Future.value(Ticket(text)),
      create: () async {
        if (create != null) return await create!();
        final c = Client();
        clients.add(c);
        return c;
      },
      httpClient: () => MockClient((request) async {
        requests.add(request);
        if (handle != null) return handle!(request);
        return respond(request);
      }),
      cleanupTimeout: const Duration(milliseconds: 30),
    ),
  );
  http.Response respond(http.Request request) {
    final path = request.url.path;
    if (path == '/health') {
      return http.Response(
        jsonEncode({'service': 'locho-notes', 'apiVersion': 1}),
        200,
      );
    }
    if (path == '/auth/login') {
      return http.Response(
        jsonEncode({
          'token': 'synthetic-token',
          'user': {'id': 'user', 'email': 'user@example.test'},
        }),
        200,
      );
    }
    if (path == '/api/me') {
      return http.Response(
        jsonEncode({
          'user': {'id': 'user', 'email': 'user@example.test'},
        }),
        200,
      );
    }
    if (path == '/auth/logout') return http.Response('', 204);
    return http.Response('{"notes":[]}', 200);
  }

  Future<void> login() async {
    await session.pair('a');
    await session.login('user', 'password');
  }
}

Future<void> tick() => Future<void>.delayed(Duration.zero);

void main() {
  test(
    'logout invalidates pending login and clears local authentication',
    () async {
      final f = Fixture();
      await f.session.pair('a');
      final response = Completer<http.Response>();
      f.handle = (request) async => request.url.path == '/auth/login'
          ? response.future
          : f.respond(request);
      final login = f.session.login('u', 'p');
      await tick();
      await f.session.logout();
      response.complete(
        f.respond(
          http.Request('POST', Uri.parse('http://localhost/auth/login')),
        ),
      );
      await login;
      expect(f.session.user, isNull);
      expect(f.session.phase, 'disconnected');
      await f.session.reconnect();
      expect(f.session.phase, 'login');
      await f.session.close();
    },
  );
  test(
    'revocation redirects are not followed and logout remains unconfirmed',
    () async {
      final f = Fixture();
      await f.login();
      await f.session.setRemember(true);
      f.handle = (request) async => request.url.path == '/auth/logout'
          ? http.Response(
              '',
              302,
              headers: {'location': 'https://elsewhere.invalid'},
            )
          : f.respond(request);
      await f.session.logout();
      expect(f.session.message, contains('unconfirmed'));
      expect(jsonDecode(f.storage.record!)['token'], isNull);
      expect(
        f.requests
            .where((r) => r.url.path == '/auth/logout')
            .single
            .followRedirects,
        false,
      );
      await f.session.close();
    },
  );
  test('manual pairing wins over an obsolete stored-record read', () async {
    final read = Completer<String?>();
    final f = Fixture();
    final session = NotesSession(
      ReadGate(read),
      dependencies: SessionDependencies(
        parse: (text) async => Ticket(text),
        create: () async => Client(),
        httpClient: () => MockClient((request) async => f.respond(request)),
      ),
    );
    final restore = session.restore();
    await session.pair('manual');
    read.complete(
      jsonEncode({
        'version': 1,
        'scope': 'obsolete/api/tcp',
        'ticket': 'obsolete',
        'token': 'old',
      }),
    );
    await restore;
    expect(session.phase, 'login');
    expect(session.label, contains('manual'));
    await session.close();
  });
  test('repeated resume does not create duplicate active owners', () async {
    final f = Fixture();
    await f.login();
    f.session.suspend();
    f.session.suspend();
    await Future.wait([f.session.resume(), f.session.resume()]);
    expect(f.session.phase, 'notes');
    expect(f.clients.length, 2);
    f.session.disconnect();
    await f.session.resume();
    expect(f.clients.length, 2);
    await f.session.close();
  });
  test('stalled cleanup returns within the configured budget', () async {
    final f = Fixture();
    await f.login();
    final release = Completer<void>();
    f.clients.first.closing = release.future;
    await f.session.close().timeout(const Duration(seconds: 1));
    release.complete();
  });
  testWidgets('scope change clears note editor and password fields', (
    tester,
  ) async {
    final f = Fixture();
    await tester.pumpWidget(NotesApp(session: f.session));
    await tester.pumpAndSettle();
    final login = f.login();
    await tester.pumpAndSettle();
    await login;
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('Title')),
      'Old private title',
    );
    await tester.enterText(
      find.byKey(const ValueKey('Body')),
      'Old private body',
    );
    final pairing = f.session.pair('new-host');
    await tester.pumpAndSettle();
    await pairing;
    await tester.pumpAndSettle();
    final secondLogin = f.session.login('u', 'p');
    await tester.pumpAndSettle();
    await secondLogin;
    await tester.pumpAndSettle();
    final title = tester.widget<TextField>(find.byKey(const ValueKey('Title')));
    final body = tester.widget<TextField>(find.byKey(const ValueKey('Body')));
    expect(title.controller!.text, '');
    expect(body.controller!.text, '');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });
  test('forget during ticket parse leaves no native owner', () async {
    final f = Fixture();
    final parse = Completer<Pairing>();
    f.parse = (_) => parse.future;
    final pairing = f.session.pair('a');
    await tick();
    await f.session.forget();
    parse.complete(Ticket());
    await pairing;
    expect(f.clients, isEmpty);
    expect(f.session.phase, 'unpaired');
    await f.session.close();
  });
  test('late client creation closes owner after disconnect', () async {
    final f = Fixture();
    final creation = Completer<TunnelClient>();
    f.create = () => creation.future;
    final pairing = f.session.pair('a');
    await tick();
    f.session.disconnect();
    final client = Client();
    creation.complete(client);
    await pairing;
    expect(client.closes, 1);
    expect(f.session.phase, 'disconnected');
  });
  test('late attachment cannot resurrect forgotten state', () async {
    final f = Fixture();
    final attachment = Completer<Attachment>();
    final client = Client()..attaching = () => attachment.future;
    f.create = () async => client;
    final pairing = f.session.pair('a');
    await tick();
    await f.session.forget();
    attachment.complete(client.link);
    await pairing;
    expect(client.closes, greaterThanOrEqualTo(1));
    expect(f.session.phase, 'unpaired');
  });
  for (final stage in ['/health', '/auth/login']) {
    test('forget invalidates late $stage response', () async {
      final f = Fixture();
      final response = Completer<http.Response>();
      f.handle = (r) async =>
          r.url.path == stage ? response.future : f.respond(r);
      Future<void> operation;
      if (stage == '/health') {
        operation = f.session.pair('a');
      } else {
        await f.session.pair('a');
        operation = f.session.login('u', 'p');
      }
      await tick();
      await f.session.forget();
      response.complete(
        f.respond(http.Request('GET', Uri.parse('http://localhost$stage'))),
      );
      await operation;
      expect(f.session.phase, 'unpaired');
      expect(f.session.user, isNull);
      expect(f.storage.record, isNull);
    });
  }
  test('in-flight save is followed by forget deletion', () async {
    final f = Fixture();
    await f.login();
    final started = Completer<void>(), release = Completer<void>();
    f.storage.writing = (record) async {
      if (record != null) {
        if (!started.isCompleted) started.complete();
        await release.future;
      }
    };
    final saving = f.session.setRemember(true);
    await started.future;
    expect(f.session.storageBusy, true);
    final forget = f.session.forget();
    release.complete();
    await Future.wait([saving, forget]);
    expect(f.storage.record, isNull);
    expect(f.session.storageBusy, false);
  });
  test(
    'remember off retains live session and exposes retry after deletion failure',
    () async {
      final f = Fixture();
      await f.login();
      await f.session.setRemember(true);
      f.storage.fail = true;
      await f.session.setRemember(false);
      expect(f.session.phase, 'notes');
      expect(f.storage.record, isNotNull);
      expect(f.session.storageError, contains('Storage failed'));
      f.storage.fail = false;
      await f.session.persist();
      expect(f.storage.record, isNull);
      expect(f.session.storageError, '');
      await f.session.close();
    },
  );
  test(
    'redirect requests are disabled and 302 is an API error, not a replay',
    () async {
      final f = Fixture();
      await f.login();
      f.handle = (_) async => http.Response(
        '',
        302,
        headers: {'location': 'https://elsewhere.invalid'},
      );
      await f.session.refresh();
      expect(f.session.message, contains('302'));
      expect(f.requests.every((request) => !request.followRedirects), true);
      await f.session.close();
    },
  );
  test(
    'failed cleanup does not block new session and terminal status hides notes',
    () async {
      final f = Fixture();
      await f.login();
      f.clients.first.failClose = true;
      f.session.suspend();
      await f.session.resume();
      expect(f.session.phase, 'notes');
      f.clients.last.link.controller.add(LochoState.failed);
      expect(f.session.phase, 'disconnected');
      expect(f.session.user, isNull);
      await f.session.close();
    },
  );
  test(
    'close is shared, bounded, and suppresses late notifications and starts',
    () async {
      final f = Fixture();
      await f.login();
      final one = f.session.close(), two = f.session.close();
      expect(identical(one, two), true);
      await one;
      final count = f.clients.length;
      await f.session.pair('b');
      await f.session.resume();
      expect(f.clients.length, count);
    },
  );
  test(
    'scope switch clears editor revision and does not send previous token',
    () async {
      final f = Fixture();
      await f.login();
      final revision = f.session.editorRevision;
      final start = f.requests.length;
      await f.session.pair('b');
      expect(f.session.editorRevision, greaterThan(revision));
      expect(f.session.phase, 'login');
      expect(
        f.requests
            .skip(start)
            .every((r) => !r.headers.containsKey('Authorization')),
        true,
      );
      await f.session.close();
    },
  );
}

class ReadGate implements Credentials {
  final Completer<String?> value;
  ReadGate(this.value);
  @override
  Future<String?> read() => value.future;
  @override
  Future<void> replace(String? next) async {}
}
