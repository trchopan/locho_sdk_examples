import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;

/// Contract-equivalent to browser NoteEventParser; no event history or replay.
class NoteEventParser {
  final void Function(Map<String, dynamic>) changed;
  late final ByteConversionSink _decoder;
  String _line = '', _event = '';
  final List<String> _data = [];
  int _bytes = 0;
  bool _cr = false;
  NoteEventParser(this.changed) {
    _decoder = const Utf8Decoder().startChunkedConversion(_TextSink(_text));
  }
  void add(List<int> bytes) => _decoder.add(bytes);
  void end() => _decoder.close(); // never dispatch an unterminated final event
  void _text(String text) {
    for (final rune in text.runes) {
      final character = String.fromCharCode(rune);
      if (_cr) {
        _cr = false;
        if (character == '\n') continue;
      }
      if (character == '\r' || character == '\n') {
        _acceptLine();
        _cr = character == '\r';
      } else {
        _line += character;
        _bytes += utf8.encode(character).length;
        if (_bytes > 4096) throw const FormatException('Event limit');
      }
    }
  }

  void _acceptLine() {
    final line = _line;
    _line = '';
    if (line.isEmpty) {
      if (_event == 'note.changed' && _data.isNotEmpty) {
        final value = jsonDecode(_data.join('\n'));
        if (value is! Map<String, dynamic> ||
            value.length != 2 ||
            !['created', 'updated', 'deleted'].contains(value['operation']) ||
            value['noteId'] is! String ||
            (value['noteId'] as String).isEmpty ||
            (value['noteId'] as String).runes.length > 128) {
          throw const FormatException('Invalid event');
        }
        changed(value);
      }
      _event = '';
      _data.clear();
      _bytes = 0;
    } else if (line.startsWith(':')) {
      _bytes -= utf8.encode(line).length;
    } else {
      if (++_bytes > 4096) throw const FormatException('Event limit');
      final separator = line.indexOf(':');
      final field = separator < 0 ? line : line.substring(0, separator);
      var value = separator < 0 ? '' : line.substring(separator + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      if (field == 'event') _event = value;
      if (field == 'data') _data.add(value);
    }
  }
}

class _TextSink extends StringConversionSinkBase {
  final void Function(String) text;
  _TextSink(this.text);
  @override
  void add(String chunk) => text(chunk);
  @override
  void addSlice(String chunk, int start, int end, bool isLast) {
    text(chunk.substring(start, end));
    if (isLast) close();
  }

  @override
  void close() {}
}

/// One dedicated HTTP client/reader/retry timer per authenticated foreground owner.
class NoteEventWatch {
  final http.Client Function() createClient;
  final Uri uri;
  final String token;
  final Duration setupTimeout, idleTimeout, retryBase;
  final double Function() random;
  final Future<void> Function() validate, unauthorized;
  final void Function() refresh;
  final void Function(String) state;
  final _first = Completer<void>();
  Future<void>? _work;
  bool _stopped = false;
  http.Client? _client;
  Completer<void>? _abort, _delay;
  Timer? _retryTimer;
  NoteEventWatch({
    required this.createClient,
    required this.uri,
    required this.token,
    required this.validate,
    required this.unauthorized,
    required this.refresh,
    required this.state,
    required this.setupTimeout,
    required this.idleTimeout,
    required this.retryBase,
    double Function()? random,
  }) : random = random ?? Random().nextDouble;

  Future<void> start() {
    _work ??= _run();
    return _first.future;
  }

  void reconnect() {
    if (_abort != null && !_abort!.isCompleted) _abort!.complete();
    _client?.close();
  }

  Future<void> stop() async {
    _stopped = true;
    _retryTimer?.cancel();
    if (_delay != null && !_delay!.isCompleted) _delay!.complete();
    reconnect();
    await _work;
  }

  Future<void> _run() async {
    var attempt = 0, retry = false;
    while (!_stopped) {
      var retryAfter = Duration.zero;
      StreamIterator<List<int>>? reader;
      Timer? setup;
      try {
        state(retry ? 'reconnecting' : 'connecting');
        if (retry) await validate();
        if (_stopped) break;
        final client = createClient();
        _client = client;
        final abort = Completer<void>();
        _abort = abort;
        setup = Timer(setupTimeout, reconnect);
        final request = http.AbortableRequest(
          'GET',
          uri,
          abortTrigger: abort.future,
        )..followRedirects = false;
        request.headers['Authorization'] = 'Bearer $token';
        var abandoned = false;
        final pending = client.send(request).then((response) async {
          if (abandoned || _stopped || abort.isCompleted) {
            await response.stream.listen((_) {}).cancel();
            throw StateError('Obsolete stream');
          }
          return response;
        });
        http.StreamedResponse response;
        try {
          response = await pending.timeout(setupTimeout);
        } finally {
          abandoned = true;
        }
        setup.cancel();
        if (_stopped) break;
        if (response.statusCode == 401) {
          await unauthorized();
          break;
        }
        if (response.statusCode != 200) {
          final seconds = response.headers['retry-after'];
          if (response.statusCode == 429 &&
              seconds != null &&
              RegExp(r'^\d+$').hasMatch(seconds)) {
            retryAfter = Duration(
              seconds: min(int.tryParse(seconds) ?? 300, 300),
            );
          }
          throw const FormatException('Event admission');
        }
        if (!RegExp(
          r'^text/event-stream(?:\s*;|$)',
          caseSensitive: false,
        ).hasMatch(response.headers['content-type'] ?? '')) {
          throw const FormatException('Invalid stream');
        }
        reader = StreamIterator(response.stream);
        state('live');
        if (retry) refresh();
        if (!_first.isCompleted) _first.complete();
        final parser = NoteEventParser((_) => refresh());
        final opened = Stopwatch()..start();
        while (await reader.moveNext().timeout(idleTimeout)) {
          if (_stopped) break;
          parser.add(reader.current);
          if (opened.elapsed >= const Duration(seconds: 30)) attempt = 0;
        }
        if (!_stopped) parser.end();
      } catch (_) {
        // Only sanitized state leaves the watcher; HTTP content/credentials stay private.
      } finally {
        setup?.cancel();
        reconnect();
        await reader?.cancel();
        _client = null;
        _abort = null;
        if (!_first.isCompleted) _first.complete();
      }
      if (_stopped) break;
      state('reconnecting');
      retry = true;
      final backoff = min(
        30000,
        retryBase.inMilliseconds *
            pow(2, min(attempt++, 5)) *
            (0.75 + random() * 0.5),
      ).round();
      _delay = Completer<void>();
      _retryTimer = Timer(
        Duration(milliseconds: max(backoff, retryAfter.inMilliseconds)),
        () => _delay?.complete(),
      );
      await _delay!.future;
      _delay = null;
    }
  }
}
