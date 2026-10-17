import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:locho_flutter/locho_flutter.dart';
import 'transport.dart';
import 'events.dart';

abstract interface class Credentials {
  Future<String?> read();
  Future<void> replace(String? value);
}

class SecureCredentials implements Credentials {
  final FlutterSecureStorage storage = const FlutterSecureStorage();
  @override
  Future<String?> read() => storage.read(key: 'locho-notes-v1');
  @override
  Future<void> replace(String? value) => value == null
      ? storage.delete(key: 'locho-notes-v1')
      : storage.write(key: 'locho-notes-v1', value: value);
}

class ApiFailure implements Exception {
  final int status;
  ApiFailure(this.status);
}

class Obsolete implements Exception {}

class NotesSession extends ChangeNotifier {
  final Credentials storage;
  final SessionDependencies dependencies;
  NotesSession(this.storage, {SessionDependencies? dependencies})
    : dependencies = dependencies ?? SessionDependencies.native();
  String phase = 'unpaired', message = '', storageError = '', label = '';
  bool busy = false, remember = false;
  bool storageBusy = false;
  List<Map<String, dynamic>> notes = [];
  Map<String, dynamic>? user;
  Pairing? _ticket;
  String? _scope, _token;
  TunnelClient? _client;
  Attachment? _attachment;
  http.Client? _http;
  StreamSubscription<LochoState>? _watch;
  int _generation = 0, _storageRevision = 0;
  bool _desired = false, _suspended = false, _recovering = false;
  Future<void> _closing = Future.value(), _saving = Future.value();
  bool _disposed = false;
  int editorRevision = 0;
  Future<void>? _shutdown;
  final Set<http.Client> _revocations = {};
  String live = 'off';
  NoteEventWatch? _events;
  Future<void> _eventsCleanup = Future.value();
  Future<void>? _loading;
  bool _dirty = false, _refreshQueued = false;
  void changed() {
    if (!_disposed) notifyListeners();
  }

  void current(int g) {
    if (_disposed || g != _generation) throw Obsolete();
  }

  Future<void> _cleanup(
    TunnelClient? client,
    StreamSubscription<LochoState>? watch,
  ) async {
    // dev.2 unsubscribe is independent of owner close and bounded by one bridge wait.
    bool failed = false;
    try {
      await watch?.cancel().timeout(dependencies.cleanupTimeout);
    } catch (_) {
      failed = true;
    }
    try {
      await client?.close().timeout(dependencies.cleanupTimeout);
    } catch (_) {
      failed = true;
    }
    if (failed && !_disposed) {
      message = 'Cleanup could not be confirmed within its budget.';
      changed();
    }
  }

  String? get localBase => _attachment?.httpBaseUri.toString();
  void _stopEvents() {
    final events = _events;
    _events = null;
    _eventsCleanup = Future.wait([
      _eventsCleanup,
      if (events != null) events.stop(),
    ]).then((_) {}).catchError((Object _) {});
    live = 'off';
  }

  Future<void> _clearAuth(int g) async {
    current(g);
    _stopEvents();
    _token = null;
    _loading = null;
    _dirty = false;
    editorRevision++;
    user = null;
    notes = [];
    phase = 'login';
    changed();
    await persist();
    current(g);
  }

  Future<void> _startEvents(int g) async {
    await _eventsCleanup;
    current(g);
    final factory = dependencies.eventClient, attachment = _attachment;
    if (factory == null ||
        _token == null ||
        attachment == null ||
        _events != null) {
      return;
    }
    late final NoteEventWatch watch;
    bool owned() => g == _generation && !_disposed && _events == watch;
    watch = NoteEventWatch(
      createClient: factory,
      uri: attachment.httpBaseUri.resolve('/api/events'),
      token: _token!,
      setupTimeout: dependencies.requestTimeout,
      idleTimeout: dependencies.eventIdleTimeout,
      retryBase: dependencies.eventRetryBase,
      random: dependencies.eventRandom,
      state: (value) {
        if (owned()) {
          live = value;
          changed();
        }
      },
      refresh: () {
        if (owned()) _queueRefresh(g);
      },
      unauthorized: () async {
        if (owned()) await _clearAuth(g);
      },
      validate: () async {
        current(g);
        final health = await call('/health', g, auth: false);
        if (health['service'] != 'locho-notes' || health['apiVersion'] != 1) {
          throw const FormatException();
        }
        final me = await call('/api/me', g);
        if (_token == null || me['user']?['id'] != user?['id']) {
          throw const FormatException();
        }
      },
    );
    _events = watch;
    await watch.start();
    current(g);
  }

  void _queueRefresh(int g) {
    _dirty = true;
    if (_refreshQueued) return;
    _refreshQueued = true;
    scheduleMicrotask(() {
      _refreshQueued = false;
      if (g != _generation || _disposed || _token == null || busy || !_dirty) {
        return;
      }
      unawaited(
        load(g).catchError((Object _) {
          if (g == _generation && _token != null) {
            live = 'reconnecting';
            changed();
            _events?.reconnect();
          }
        }),
      );
    });
  }

  int invalidate({bool closeClient = true}) {
    _generation++;
    _stopEvents();
    _dirty = false;
    _loading = null;
    final client = _client, watch = _watch;
    _client = null;
    _watch = null;
    _attachment = null;
    _http?.close();
    _http = null;
    _closing = _closing.then(
      (_) => _cleanup(closeClient ? client : null, watch),
    );
    return _generation;
  }

  Future<void> persist() async {
    if (_disposed) return;
    final revision = ++_storageRevision;
    storageBusy = true;
    changed();
    String? record;
    if (remember && _ticket != null) {
      String encoded;
      try {
        encoded = await _ticket!.export();
      } catch (_) {
        if (revision == _storageRevision) {
          storageError = 'Credentials could not be exported for storage.';
          storageBusy = false;
          changed();
        }
        return;
      }
      if (revision != _storageRevision) return;
      record = jsonEncode({
        'version': 1,
        'scope': _scope,
        'ticket': encoded,
        'token': _token,
      });
    }
    _saving = _saving.then((_) async {
      if (revision != _storageRevision) return;
      try {
        await storage.replace(record);
        if (revision == _storageRevision) storageError = '';
      } catch (_) {
        if (revision == _storageRevision) {
          storageError =
              'Storage failed. Saved credentials may remain; retry or clear app storage.';
        }
      }
      if (revision == _storageRevision) changed();
      if (revision == _storageRevision) {
        storageBusy = false;
        changed();
      }
    });
    await _saving;
  }

  Future<void> setRemember(bool value) async {
    if (_disposed) return;
    remember = value;
    changed();
    await persist();
  }

  Future<void> restore() async {
    if (_disposed) return;
    final g = _generation, revision = _storageRevision;
    try {
      final value = await storage.read();
      current(g);
      if (revision != _storageRevision || value == null) return;
      if (value.length > 20000) throw const FormatException();
      final record = jsonDecode(value) as Map<String, dynamic>;
      final ticket = await dependencies.parse(record['ticket'] as String);
      current(g);
      if (revision != _storageRevision) return;
      final scope = '${ticket.hostId}/${ticket.service}/${ticket.serviceType}';
      if (record['version'] != 1 ||
          scope != record['scope'] ||
          (record['token'] != null && record['token'] is! String)) {
        throw const FormatException();
      }
      _ticket = ticket;
      _scope = scope;
      _token = record['token'] as String?;
      remember = true;
      _desired = true;
      if (!_suspended) {
        await connectTicket(ticket);
      } else {
        phase = 'disconnected';
        changed();
      }
    } catch (_) {
      if (g == _generation) {
        storageError =
            'Saved credentials could not be restored. Pair again or forget.';
        changed();
      }
    }
  }

  Future<void> pair(String text) async {
    if (_disposed || _suspended) return;
    final g = invalidate();
    busy = true;
    phase = 'connecting';
    notes = [];
    user = null;
    message = '';
    changed();
    try {
      final ticket = await dependencies.parse(text.trim());
      current(g);
      await connectTicket(ticket);
    } catch (_) {
      if (g == _generation) {
        busy = false;
        phase = 'disconnected';
        message = 'Pairing failed. Check ticket and network.';
        changed();
      }
    }
  }

  Future<void> connectTicket(Pairing ticket) async {
    if (_suspended || _disposed) return;
    final g = invalidate();
    _desired = true;
    busy = true;
    phase = 'connecting';
    notes = [];
    user = null;
    message = '';
    changed();
    TunnelClient? client;
    try {
      if (ticket.serviceType != 'tcp') throw const FormatException();
      final scope = '${ticket.hostId}/${ticket.service}/${ticket.serviceType}';
      if (_scope != scope) {
        _token = null;
        editorRevision++;
      }
      _ticket = ticket;
      _scope = scope;
      label = '${ticket.service} · ${ticket.hostId.substring(0, 12)}';
      await persist();
      current(g);
      await _closing;
      current(g);
      client = await dependencies.create();
      current(g);
      _client = client;
      final attachment = await client.attach(ticket);
      current(g);
      _attachment = attachment;
      _http = dependencies.httpClient();
      phase = 'checking';
      changed();
      final health = await call('/health', g, auth: false);
      if (health['service'] != 'locho-notes' || health['apiVersion'] != 1) {
        throw const FormatException();
      }
      if (_token != null) {
        try {
          final me = await call('/api/me', g);
          user = Map<String, dynamic>.from(me['user']);
          await _startEvents(g);
          if (_token != null) await load(g);
        } on ApiFailure catch (error) {
          if (error.status != 401) rethrow;
        }
      }
      current(g);
      phase = _token == null ? 'login' : 'notes';
      busy = false;
      if (_dirty) _queueRefresh(g);
      _watch = attachment.states.listen(
        (status) {
          if (g != _generation || _disposed || _suspended) return;
          if ([LochoState.failed, LochoState.closed].contains(status)) {
            disconnect();
            message =
                'Transport stopped. Credentials retained; reconnect explicitly.';
            changed();
            return;
          }
          if (status == LochoState.reconnecting) {
            _recovering = true;
            phase = 'disconnected';
            notes = [];
            user = null;
            message = 'Reconnecting; requests are not replayed.';
            changed();
          } else if (_recovering && status == LochoState.connected && !busy) {
            _recovering = false;
            unawaited(reconnect());
          }
        },
        onError: (_) {
          if (g == _generation) {
            disconnect();
            message = 'Transport status unavailable. Reconnect explicitly.';
            changed();
          }
        },
      );
      changed();
    } catch (_) {
      await _cleanup(client, null);
      if (g == _generation) {
        _stopEvents();
        _client = null;
        _http?.close();
        _http = null;
        busy = false;
        phase = 'disconnected';
        message = 'Connection or API validation failed. Credentials retained.';
        changed();
      }
    }
  }

  Future<dynamic> call(
    String path,
    int g, {
    bool auth = true,
    String method = 'GET',
    Object? body,
  }) async {
    current(g);
    final attachment = _attachment, api = _http;
    final token = auth ? _token : null;
    void authenticatedCurrent() {
      current(g);
      if (auth && token != _token) throw Obsolete();
    }

    if (attachment == null || api == null) throw StateError('disconnected');
    final abort = Completer<void>();
    final timer = Timer(dependencies.requestTimeout, () => abort.complete());
    try {
      final request = http.AbortableRequest(
        method,
        attachment.httpBaseUri.resolve(path),
        abortTrigger: abort.future,
      );
      request.followRedirects = false;
      if (auth && _token != null) {
        request.headers['Authorization'] = 'Bearer $_token';
      }
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      final response = await api.send(request);
      authenticatedCurrent();
      final bytes = <int>[];
      await for (final chunk in response.stream) {
        if (bytes.length + chunk.length > 8 * 1024 * 1024) {
          api.close();
          throw StateError('limit');
        }
        bytes.addAll(chunk);
      }
      authenticatedCurrent();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        if (auth && response.statusCode == 401) {
          await _clearAuth(g);
        }
        throw ApiFailure(response.statusCode);
      }
      if (response.statusCode == 204) return null;
      return jsonDecode(utf8.decode(bytes));
    } finally {
      timer.cancel();
    }
  }

  Future<void> action(
    Future<void> Function(int) run, {
    bool mutation = false,
  }) async {
    if (busy || _disposed || _suspended) return;
    final g = _generation;
    busy = true;
    message = '';
    changed();
    try {
      await run(g);
      current(g);
    } catch (error) {
      if (g == _generation) {
        message = error is ApiFailure
            ? 'API request rejected (HTTP ${error.status}).'
            : mutation
            ? 'Write outcome unknown. Refresh to confirm; no replay.'
            : 'Request failed. Check connection or reconnect.';
      }
    } finally {
      if (g == _generation) {
        busy = false;
        if (_dirty) _queueRefresh(g);
        changed();
      }
    }
  }

  Future<void> login(String email, String password) => action((g) async {
    final data = await call(
      '/auth/login',
      g,
      auth: false,
      method: 'POST',
      body: {'email': email, 'password': password},
    );
    if (data['token'] is! String || data['user'] is! Map) {
      throw const FormatException();
    }
    if (user?['id'] != data['user']['id']) editorRevision++;
    _token = data['token'];
    user = Map<String, dynamic>.from(data['user']);
    await persist();
    current(g);
    await _startEvents(g);
    if (_token != null) {
      await load(g);
      phase = 'notes';
    }
  });
  Future<void> load(int g) {
    if (_loading != null) {
      _dirty = true;
      return _loading!;
    }
    late final Future<void> work;
    work =
        (() async {
          do {
            current(g);
            _dirty = false;
            await _loadOnce(g);
          } while (_dirty && _token != null);
        })().whenComplete(() {
          if (identical(_loading, work)) _loading = null;
        });
    _loading = work;
    return work;
  }

  Future<void> _loadOnce(int g) async {
    final data = await call('/api/notes', g);
    final rows = data['notes'] as List;
    if (rows.length > 100) throw const FormatException();
    final parsed = rows
        .map((value) => Map<String, dynamic>.from(value))
        .toList();
    if (parsed.any(
      (row) =>
          row['id'] is! String ||
          row['title'] is! String ||
          row['body'] is! String,
    )) {
      throw const FormatException();
    }
    notes = parsed;
    changed();
  }

  Future<void> refresh() => action(load);
  Future<void> save(String title, String body, String? id) => action((g) async {
    if (title.trim().isEmpty ||
        title.trim().runes.length > 200 ||
        utf8.encode(body).length > 16000) {
      message = 'Title 1–200 characters; body at most 16000 UTF-8 bytes.';
      return;
    }
    await call(
      id == null ? '/api/notes' : '/api/notes/${Uri.encodeComponent(id)}',
      g,
      method: id == null ? 'POST' : 'PATCH',
      body: {'title': title, 'body': body},
    );
    await load(g);
  }, mutation: true);
  Future<void> remove(String id) => action((g) async {
    await call('/api/notes/${Uri.encodeComponent(id)}', g, method: 'DELETE');
    await load(g);
  }, mutation: true);
  Future<void> reconnect() async {
    final ticket = _ticket;
    if (ticket != null) await connectTicket(ticket);
  }

  void disconnect({bool preserveIntent = false}) {
    if (_disposed) return;
    if (!preserveIntent) _desired = false;
    invalidate();
    busy = false;
    phase = _ticket == null ? 'unpaired' : 'disconnected';
    notes = [];
    user = null;
    changed();
  }

  void suspend() {
    _suspended = true;
    disconnect(preserveIntent: true);
  }

  Future<void> resume() async {
    if (_disposed) return;
    _suspended = false;
    if (_desired && _ticket != null && !busy && _client == null) {
      await reconnect();
    }
  }

  Future<void> forget() async {
    if (_disposed) return;
    editorRevision++;
    _desired = false;
    remember = false;
    invalidate();
    _ticket = null;
    _scope = null;
    _token = null;
    label = '';
    user = null;
    notes = [];
    phase = 'unpaired';
    busy = false;
    changed();
    await persist();
  }

  Future<void> logout() async {
    if (_disposed) return;
    editorRevision++;
    final ticket = _ticket;
    final client = _client;
    final attachment = _attachment;
    final token = _token;
    // Remove local auth immediately; a separate bounded request attempts revocation.
    _token = null;
    final g = invalidate(closeClient: false);
    busy = true;
    _desired = false;
    message = '';
    user = null;
    notes = [];
    phase = ticket == null ? 'unpaired' : 'disconnected';
    changed();
    final saving = persist();
    bool revoked = false;
    final revocation = dependencies.httpClient();
    _revocations.add(revocation);
    try {
      if (token != null && attachment != null && client != null) {
        // Retain only this old client for the bounded revocation attempt.
        final request = http.AbortableRequest(
          'POST',
          attachment.httpBaseUri.resolve('/auth/logout'),
        )..followRedirects = false;
        request.headers['Authorization'] = 'Bearer $token';
        final response = await revocation
            .send(request)
            .timeout(dependencies.requestTimeout);
        revoked = response.statusCode == 204;
      }
    } catch (_) {
    } finally {
      revocation.close();
      _revocations.remove(revocation);
      await _cleanup(client, null);
    }
    await saving;
    if (g != _generation) return;
    disconnect();
    message = revoked
        ? 'Logged out.'
        : 'Local token removed. Server revocation unconfirmed.';
    changed();
  }

  Future<void> close() => _shutdown ??= _close();
  Future<void> _close() async {
    _desired = false;
    invalidate();
    _disposed = true;
    _storageRevision++;
    for (final client in _revocations) {
      client.close();
    }
    await _closing;
    try {
      await _eventsCleanup.timeout(dependencies.cleanupTimeout);
    } catch (_) {
      /* bounded shutdown */
    }
    try {
      await _saving.timeout(dependencies.cleanupTimeout);
    } catch (_) {
      /* OS storage may be unavailable. */
    }
  }

  @override
  void dispose() {
    unawaited(close());
    super.dispose();
  }
}
