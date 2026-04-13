import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'models.dart';

abstract class ManyoyoRepository {
  Future<StoredSession> login({
    required String baseUrl,
    required String username,
    required String password,
  });

  Future<void> logout(StoredSession session);

  Future<List<SessionSummary>> fetchSessions(StoredSession session);

  Future<SessionDetail> fetchSessionDetail(
    StoredSession session,
    String sessionName,
  );

  Future<List<MessageItem>> fetchMessages(
    StoredSession session,
    String sessionName,
  );

  Stream<AgentStreamEvent> streamAgent(
    StoredSession session,
    String sessionName,
    String prompt,
  );

  Future<RunCommandResult> runCommand(
    StoredSession session,
    String sessionName,
    String command,
  );

  Future<void> stopAgent(StoredSession session, String sessionName);

  Future<FileListResult> listFiles(
    StoredSession session,
    String sessionName,
    String path,
  );

  Future<FileReadResult> readFile(
    StoredSession session,
    String sessionName,
    String path, {
    bool full = true,
  });

  Future<void> writeFile(
    StoredSession session,
    String sessionName,
    String path,
    String content,
  );

  Future<void> mkdir(StoredSession session, String sessionName, String path);

  Future<ConfigSnapshot> fetchConfig(StoredSession session);

  Future<void> saveConfig(StoredSession session, String raw);

  Future<String> createSession(StoredSession session, CreateSessionDraft draft);

  Future<CreateSessionSeed> loadCreateSessionSeed(StoredSession session);

  Future<TerminalConnection> openTerminal(
    StoredSession session,
    String sessionName, {
    int cols = 120,
    int rows = 36,
  });
}

class ManyoyoApiException implements Exception {
  ManyoyoApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  bool get unauthorized => statusCode == 401;

  @override
  String toString() => message;
}

class HttpManyoyoRepository implements ManyoyoRepository {
  HttpManyoyoRepository({HttpClient? client})
    : _client = client ?? HttpClient();

  final HttpClient _client;

  @override
  Future<String> createSession(
    StoredSession session,
    CreateSessionDraft draft,
  ) async {
    final payload = await _sendJson(
      session,
      'POST',
      '/api/sessions',
      body: draft.toJson(),
    );
    return asString(payload['name']);
  }

  @override
  Future<ConfigSnapshot> fetchConfig(StoredSession session) async {
    final payload = await _sendJson(session, 'GET', '/api/config');
    return ConfigSnapshot.fromJson(payload);
  }

  @override
  Future<List<MessageItem>> fetchMessages(
    StoredSession session,
    String sessionName,
  ) async {
    final payload = await _sendJson(
      session,
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/messages',
    );
    return asJsonList(
      payload['messages'],
    ).map((dynamic item) => MessageItem.fromJson(asJsonMap(item))).toList();
  }

  @override
  Future<SessionDetail> fetchSessionDetail(
    StoredSession session,
    String sessionName,
  ) async {
    final payload = await _sendJson(
      session,
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/detail',
    );
    return SessionDetail.fromJson(asJsonMap(payload['detail']));
  }

  @override
  Future<List<SessionSummary>> fetchSessions(StoredSession session) async {
    final payload = await _sendJson(session, 'GET', '/api/sessions');
    return asJsonList(
      payload['sessions'],
    ).map((dynamic item) => SessionSummary.fromJson(asJsonMap(item))).toList();
  }

  @override
  Future<StoredSession> login({
    required String baseUrl,
    required String username,
    required String password,
  }) async {
    final session = StoredSession(
      baseUrl: _normalizeBaseUrl(baseUrl),
      username: username.trim(),
      cookie: '',
    );
    final request = await _openRequest(
      session,
      'POST',
      '/auth/login',
      includeCookie: false,
    );
    request.headers.contentType = ContentType.json;
    request.write(
      encodeRequestBody(<String, dynamic>{
        'username': username.trim(),
        'password': password,
      }),
    );
    final response = await request.close();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw await _buildError(response);
    }
    final authCookie = response.cookies
        .where((Cookie item) => item.name == 'manyoyo_web_auth')
        .map((Cookie item) => '${item.name}=${item.value}')
        .cast<String?>()
        .firstWhere((String? value) => value != null, orElse: () => null);
    await response.drain<void>();
    if (authCookie == null || authCookie.isEmpty) {
      throw ManyoyoApiException('登录成功但未获取到认证 Cookie');
    }
    return session.copyWith(cookie: authCookie);
  }

  @override
  Future<CreateSessionSeed> loadCreateSessionSeed(StoredSession session) async {
    final config = await fetchConfig(session);
    final runs = <String, Map<String, dynamic>>{};
    final rawRuns = asJsonMap(config.parsed['runs']);
    for (final MapEntry<String, dynamic> entry in rawRuns.entries) {
      runs[entry.key] = asJsonMap(entry.value);
    }
    return CreateSessionSeed(defaults: config.defaults, runs: runs);
  }

  @override
  Future<FileListResult> listFiles(
    StoredSession session,
    String sessionName,
    String path,
  ) async {
    final payload = await _sendJson(
      session,
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/fs/list',
      query: <String, String>{'path': path},
    );
    return FileListResult.fromJson(payload);
  }

  @override
  Future<void> logout(StoredSession session) async {
    await _sendJson(session, 'POST', '/auth/logout');
  }

  @override
  Future<TerminalConnection> openTerminal(
    StoredSession session,
    String sessionName, {
    int cols = 120,
    int rows = 36,
  }) async {
    return WebSocketTerminalConnection.connect(
      session: session,
      sessionName: sessionName,
      cols: cols,
      rows: rows,
    );
  }

  @override
  Future<void> mkdir(
    StoredSession session,
    String sessionName,
    String path,
  ) async {
    await _sendJson(
      session,
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/fs/mkdir',
      body: <String, dynamic>{'path': path},
    );
  }

  @override
  Future<FileReadResult> readFile(
    StoredSession session,
    String sessionName,
    String path, {
    bool full = true,
  }) async {
    final payload = await _sendJson(
      session,
      'GET',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/fs/read',
      query: <String, String>{'path': path, if (full) 'full': 'true'},
    );
    return FileReadResult.fromJson(payload);
  }

  @override
  Future<void> saveConfig(StoredSession session, String raw) async {
    await _sendJson(
      session,
      'PUT',
      '/api/config',
      body: <String, dynamic>{'raw': raw},
    );
  }

  @override
  Stream<AgentStreamEvent> streamAgent(
    StoredSession session,
    String sessionName,
    String prompt,
  ) async* {
    final request = await _openRequest(
      session,
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/agent/stream',
    );
    request.headers.contentType = ContentType.json;
    request.write(encodeRequestBody(<String, dynamic>{'prompt': prompt}));
    final response = await request.close();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw await _buildError(response);
    }
    await for (final String line
        in utf8.decoder.bind(response).transform(const LineSplitter())) {
      final text = line.trim();
      if (text.isEmpty) {
        continue;
      }
      yield AgentStreamEvent.fromJson(asJsonMap(jsonDecode(text)));
    }
  }

  @override
  Future<RunCommandResult> runCommand(
    StoredSession session,
    String sessionName,
    String command,
  ) async {
    final payload = await _sendJson(
      session,
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/run',
      body: <String, dynamic>{'command': command},
    );
    return RunCommandResult.fromJson(payload);
  }

  @override
  Future<void> stopAgent(StoredSession session, String sessionName) async {
    await _sendJson(
      session,
      'POST',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/agent/stop',
    );
  }

  @override
  Future<void> writeFile(
    StoredSession session,
    String sessionName,
    String path,
    String content,
  ) async {
    await _sendJson(
      session,
      'PUT',
      '/api/sessions/${Uri.encodeComponent(sessionName)}/fs/write',
      body: <String, dynamic>{'path': path, 'content': content},
    );
  }

  Future<ManyoyoApiException> _buildError(HttpClientResponse response) async {
    final text = await utf8.decoder.bind(response).join();
    if (text.trim().isNotEmpty) {
      try {
        final payload = asJsonMap(jsonDecode(text));
        final error = asString(payload['error']);
        final detail = asString(payload['detail']);
        final message = detail.isNotEmpty ? '$error: $detail' : error;
        if (message.isNotEmpty) {
          return ManyoyoApiException(message, statusCode: response.statusCode);
        }
      } catch (_) {
        return ManyoyoApiException(
          text.trim(),
          statusCode: response.statusCode,
        );
      }
      return ManyoyoApiException(text.trim(), statusCode: response.statusCode);
    }
    return ManyoyoApiException(
      '请求失败（HTTP ${response.statusCode}）',
      statusCode: response.statusCode,
    );
  }

  Future<HttpClientRequest> _openRequest(
    StoredSession session,
    String method,
    String path, {
    Map<String, String>? query,
    bool includeCookie = true,
  }) async {
    final uri = _buildUri(session.baseUrl, path, query);
    final request = switch (method) {
      'GET' => await _client.getUrl(uri),
      'POST' => await _client.postUrl(uri),
      'PUT' => await _client.putUrl(uri),
      'DELETE' => await _client.deleteUrl(uri),
      _ => throw ArgumentError.value(method, 'method', 'unsupported'),
    };
    request.followRedirects = false;
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    if (includeCookie && session.cookie.isNotEmpty) {
      request.headers.set(HttpHeaders.cookieHeader, session.cookie);
    }
    if (method != 'GET' && method != 'HEAD') {
      request.headers.set('X-Requested-With', 'XMLHttpRequest');
    }
    return request;
  }

  Future<Map<String, dynamic>> _sendJson(
    StoredSession session,
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    final request = await _openRequest(session, method, path, query: query);
    if (body != null) {
      request.headers.contentType = ContentType.json;
      request.write(encodeRequestBody(body));
    }
    final response = await request.close();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw await _buildError(response);
    }
    final text = await utf8.decoder.bind(response).join();
    return text.trim().isEmpty
        ? <String, dynamic>{}
        : asJsonMap(jsonDecode(text));
  }

  Uri _buildUri(String baseUrl, String path, [Map<String, String>? query]) {
    final base = Uri.parse(_normalizeBaseUrl(baseUrl));
    return base.replace(
      path: path,
      queryParameters: query == null || query.isEmpty ? null : query,
    );
  }

  String _normalizeBaseUrl(String value) {
    final trimmed = value.trim();
    if (trimmed.endsWith('/')) {
      return trimmed.substring(0, trimmed.length - 1);
    }
    return trimmed;
  }
}

class WebSocketTerminalConnection implements TerminalConnection {
  WebSocketTerminalConnection._(this._socket) {
    _subscription = _socket.listen(
      (dynamic raw) {
        try {
          final payload = asJsonMap(jsonDecode(raw as String));
          _events.add(TerminalEvent.fromJson(payload));
        } catch (_) {
          _events.add(
            TerminalEvent(
              type: 'output',
              data: raw.toString(),
              phase: '',
              error: '',
            ),
          );
        }
      },
      onDone: () {
        _events.add(
          const TerminalEvent(
            type: 'status',
            data: '',
            phase: 'closed',
            error: '',
          ),
        );
      },
      onError: (Object error) {
        _events.add(
          TerminalEvent(
            type: 'error',
            data: '',
            phase: '',
            error: error.toString(),
          ),
        );
      },
    );
  }

  final WebSocket _socket;
  late final StreamSubscription<dynamic> _subscription;
  final StreamController<TerminalEvent> _events =
      StreamController<TerminalEvent>.broadcast();

  static Future<WebSocketTerminalConnection> connect({
    required StoredSession session,
    required String sessionName,
    required int cols,
    required int rows,
  }) async {
    final baseUri = Uri.parse(session.baseUrl);
    final scheme = baseUri.scheme == 'https' ? 'wss' : 'ws';
    final uri = baseUri.replace(
      scheme: scheme,
      path: '/api/sessions/${Uri.encodeComponent(sessionName)}/terminal/ws',
      queryParameters: <String, String>{'cols': '$cols', 'rows': '$rows'},
    );
    final socket = await WebSocket.connect(
      uri.toString(),
      headers: <String, dynamic>{
        if (session.cookie.isNotEmpty) HttpHeaders.cookieHeader: session.cookie,
      },
    );
    return WebSocketTerminalConnection._(socket);
  }

  @override
  Future<void> close() async {
    try {
      _socket.add(jsonEncode(<String, dynamic>{'type': 'close'}));
    } catch (_) {
      // ignore close send failure
    }
    await _subscription.cancel();
    await _socket.close();
    await _events.close();
  }

  @override
  Stream<TerminalEvent> get events => _events.stream;

  @override
  void resize({required int cols, required int rows}) {
    _socket.add(
      jsonEncode(<String, dynamic>{
        'type': 'resize',
        'cols': cols,
        'rows': rows,
      }),
    );
  }

  @override
  void sendInput(String data) {
    _socket.add(jsonEncode(<String, dynamic>{'type': 'input', 'data': data}));
  }
}
