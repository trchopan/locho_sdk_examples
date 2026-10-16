import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:locho_flutter/locho_flutter.dart';

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
  NotesSession(this.storage);
  String phase = 'unpaired', message = '', storageError = '', label = '';
  bool busy = false, remember = false;
  List<Map<String, dynamic>> notes = [];
  Map<String, dynamic>? user;
  LochoTicket? _ticket;
  String? _scope, _token;
  LochoClient? _client;
  LochoAttachment? _attachment;
  http.Client? _http;
  StreamSubscription<LochoStatus>? _watch;
  int _generation = 0, _storageRevision = 0;
  bool _desired = false, _suspended = false, _recovering = false;
  Future<void> _closing = Future.value(), _saving = Future.value();
  void changed() => notifyListeners();
  void current(int g) {
    if (g != _generation) throw Obsolete();
  }

  String? get localBase => _attachment?.httpBaseUri.toString();
  int invalidate({bool closeClient = true}) {
    _generation++;
    final client = _client, watch = _watch;
    _client = null;
    _watch = null;
    _attachment = null;
    _http?.close();
    _http = null;
    _closing = _closing
        .then((_) async {
          if (closeClient) await client?.close();
          await watch?.cancel();
        })
        .catchError((_) {});
    return _generation;
  }

  Future<void> persist() async {
    final revision = ++_storageRevision;
    String? record;
    if (remember && _ticket != null) {
      String encoded;
      try {
        encoded = await _ticket!.export();
      } catch (_) {
        if (revision == _storageRevision) {
          storageError = 'Credentials could not be exported for storage.';
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
    });
    await _saving;
  }

  Future<void> setRemember(bool value) async {
    remember = value;
    changed();
    await persist();
  }

  Future<void> restore() async {
    final g = _generation, revision = _storageRevision;
    try {
      final value = await storage.read();
      current(g);
      if (revision != _storageRevision || value == null) return;
      if (value.length > 20000) throw const FormatException();
      final record = jsonDecode(value) as Map<String, dynamic>;
      final ticket = await LochoTicket.parse(record['ticket'] as String);
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
    final g = invalidate();
    busy = true;
    phase = 'connecting';
    notes = [];
    user = null;
    message = '';
    changed();
    try {
      final ticket = await LochoTicket.parse(text.trim());
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

  Future<void> connectTicket(LochoTicket ticket) async {
    if (_suspended) return;
    final g = invalidate();
    _desired = true;
    busy = true;
    phase = 'connecting';
    notes = [];
    user = null;
    message = '';
    changed();
    LochoClient? client;
    try {
      if (ticket.serviceType != 'tcp') throw const FormatException();
      final scope = '${ticket.hostId}/${ticket.service}/${ticket.serviceType}';
      if (_scope != scope) _token = null;
      _ticket = ticket;
      _scope = scope;
      label = '${ticket.service} · ${ticket.hostId.substring(0, 12)}';
      await persist();
      current(g);
      await _closing;
      current(g);
      client = await LochoClient.create();
      current(g);
      _client = client;
      final attachment = await client.attach(ticket: ticket);
      current(g);
      _attachment = attachment;
      _http = http.Client();
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
          await load(g);
        } on ApiFailure catch (error) {
          if (error.status != 401) rethrow;
        }
      }
      current(g);
      phase = _token == null ? 'login' : 'notes';
      busy = false;
      _watch = attachment.statuses.listen((status) {
        if (g != _generation || busy || _suspended) return;
        if (status.state == LochoState.reconnecting) {
          _recovering = true;
          phase = 'disconnected';
          notes = [];
          user = null;
          message = 'Reconnecting; requests are not replayed.';
          changed();
        } else if (_recovering && status.state == LochoState.connected) {
          _recovering = false;
          unawaited(reconnect());
        }
      }, onError: (_) {});
      changed();
    } catch (_) {
      try {
        await client?.close();
      } catch (_) {
        /* retain sanitized startup error */
      }
      if (g == _generation) {
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
    if (attachment == null || api == null) throw StateError('disconnected');
    final abort = Completer<void>();
    final timer = Timer(const Duration(seconds: 15), () => abort.complete());
    try {
      final request = http.AbortableRequest(
        method,
        attachment.httpBaseUri.resolve(path),
        abortTrigger: abort.future,
      );
      if (auth && _token != null) {
        request.headers['Authorization'] = 'Bearer $_token';
      }
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      final response = await api.send(request);
      current(g);
      final bytes = <int>[];
      await for (final chunk in response.stream) {
        if (bytes.length + chunk.length > 8 * 1024 * 1024) {
          api.close();
          throw StateError('limit');
        }
        bytes.addAll(chunk);
      }
      current(g);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        if (auth && response.statusCode == 401) {
          _token = null;
          user = null;
          notes = [];
          phase = 'login';
          await persist();
          current(g);
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
    if (busy) return;
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
    _token = data['token'];
    user = Map<String, dynamic>.from(data['user']);
    await persist();
    current(g);
    await load(g);
    phase = 'notes';
  });
  Future<void> load(int g) async {
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
    _suspended = false;
    if (_desired && _ticket != null && !busy) await reconnect();
  }

  Future<void> forget() async {
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
    if (busy) return;
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
    final revocation = http.Client();
    try {
      if (token != null && attachment != null && client != null) {
        // Retain only this old client for the bounded revocation attempt.
        final response = await revocation
            .post(
              attachment.httpBaseUri.resolve('/auth/logout'),
              headers: {'Authorization': 'Bearer $token'},
            )
            .timeout(const Duration(seconds: 15));
        revoked = response.statusCode == 204;
      }
    } catch (_) {
    } finally {
      revocation.close();
      try {
        await client?.close();
      } catch (_) {}
    }
    await saving;
    if (g != _generation) return;
    disconnect();
    message = revoked
        ? 'Logged out.'
        : 'Local token removed. Server revocation unconfirmed.';
    changed();
  }
}
