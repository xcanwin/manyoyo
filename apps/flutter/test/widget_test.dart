import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:manyoyo_flutter/src/app.dart';
import 'package:manyoyo_flutter/src/app_controller.dart';
import 'package:manyoyo_flutter/src/models.dart';
import 'package:manyoyo_flutter/src/repository.dart';
import 'package:manyoyo_flutter/src/session_storage.dart';

void main() {
  testWidgets('shows native login screen when no saved session exists', (
    WidgetTester tester,
  ) async {
    final controller = ManyoyoAppController(
      repository: _FakeRepository(),
      storage: _MemoryStorage(),
    );

    await controller.initialize();
    await tester.pumpWidget(ManyoyoApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('Web 登录'), findsOneWidget);
    expect(find.text('登录'), findsOneWidget);
    expect(find.textContaining('WebView'), findsNothing);
  });

  testWidgets('renders native workspace for authenticated session', (
    WidgetTester tester,
  ) async {
    final controller = ManyoyoAppController(
      repository: _FakeRepository(),
      storage: _MemoryStorage(
        session: const StoredSession(
          baseUrl: 'http://127.0.0.1:3000',
          username: 'demo',
          cookie: 'manyoyo_web_auth=ok',
        ),
      ),
    );

    await controller.initialize();
    await tester.pumpWidget(ManyoyoApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('活动'), findsOneWidget);
    expect(find.text('会话'), findsOneWidget);
    expect(find.text('文件'), findsOneWidget);
    expect(find.text('终端'), findsOneWidget);
    expect(find.text('详情'), findsOneWidget);
    expect(find.text('配置'), findsOneWidget);
    expect(find.text('检查'), findsOneWidget);
    expect(find.text('demo'), findsWidgets);
    expect(find.text('发送'), findsOneWidget);
    expect(find.text('保存文件'), findsNothing);
  });
}

class _MemoryStorage implements ManyoyoSessionStorage {
  _MemoryStorage({this.session});

  StoredSession? session;

  @override
  Future<void> clear() async {
    session = null;
  }

  @override
  Future<StoredSession?> load() async => session;

  @override
  Future<void> save(StoredSession nextSession) async {
    session = nextSession;
  }
}

class _FakeRepository implements ManyoyoRepository {
  final List<SessionSummary> _sessions = [
    const SessionSummary(
      name: 'demo',
      containerName: 'demo',
      agentId: 'default',
      agentName: 'AGENT 1',
      status: 'running',
      image: 'localhost/xcanwin/manyoyo:demo',
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
      messageCount: 1,
      agentEnabled: true,
      agentProgram: 'codex',
      resumeSupported: true,
      hostPath: '/workspace/demo',
      containerPath: '/workspace/demo',
    ),
  ];

  final Map<String, List<MessageItem>> _messages = {
    'demo': const [
      MessageItem(
        id: 'm1',
        role: 'assistant',
        content: '欢迎进入 MANYOYO 原生客户端。',
        timestamp: '2026-04-14T00:00:00.000Z',
        pending: false,
        mode: 'agent',
      ),
    ],
  };

  @override
  Future<String> createSession(
    StoredSession session,
    CreateSessionDraft draft,
  ) async {
    return 'demo';
  }

  @override
  Future<ConfigSnapshot> fetchConfig(StoredSession session) async {
    return const ConfigSnapshot(
      path: '/tmp/manyoyo.json',
      raw: '{ "hostPath": "/workspace/demo" }',
      parsed: {'runs': {}},
      defaults: {'hostPath': '/workspace/demo'},
      parseError: '',
      editable: true,
      notice: 'config notice',
    );
  }

  @override
  Future<List<MessageItem>> fetchMessages(
    StoredSession session,
    String sessionName,
  ) async {
    return _messages[sessionName] ?? const <MessageItem>[];
  }

  @override
  Future<SessionDetail> fetchSessionDetail(
    StoredSession session,
    String sessionName,
  ) async {
    final summary = _sessions.first;
    return SessionDetail(
      name: summary.name,
      containerName: summary.containerName,
      agentId: summary.agentId,
      agentName: summary.agentName,
      status: summary.status,
      image: summary.image,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      messageCount: summary.messageCount,
      agentEnabled: summary.agentEnabled,
      agentProgram: summary.agentProgram,
      resumeSupported: summary.resumeSupported,
      hostPath: summary.hostPath,
      containerPath: summary.containerPath,
      latestRole: 'assistant',
      latestTimestamp: summary.updatedAt,
      agentPromptCommand: 'codex',
      containerAgentPromptCommand: '',
      agentPromptCommandOverride: '',
      inferredAgentPromptCommand: 'codex',
      agentPromptSource: 'container',
      lastResumeAt: '',
      lastResumeOk: true,
      lastResumeError: '',
      applied: const {'hostPath': '/workspace/demo'},
    );
  }

  @override
  Future<List<SessionSummary>> fetchSessions(StoredSession session) async {
    return _sessions;
  }

  @override
  Future<StoredSession> login({
    required String baseUrl,
    required String username,
    required String password,
  }) async {
    return StoredSession(
      baseUrl: baseUrl,
      username: username,
      cookie: 'manyoyo_web_auth=ok',
    );
  }

  @override
  Future<CreateSessionSeed> loadCreateSessionSeed(StoredSession session) async {
    return const CreateSessionSeed(
      defaults: {'hostPath': '/workspace/demo'},
      runs: {},
    );
  }

  @override
  Future<FileListResult> listFiles(
    StoredSession session,
    String sessionName,
    String path,
  ) async {
    return const FileListResult(
      path: '/',
      parentPath: '',
      entries: [
        FileNode(
          name: 'README.md',
          path: '/README.md',
          kind: 'file',
          size: 12,
          mtimeMs: 0,
        ),
      ],
    );
  }

  @override
  Future<void> logout(StoredSession session) async {}

  @override
  Future<void> mkdir(
    StoredSession session,
    String sessionName,
    String path,
  ) async {}

  @override
  Future<TerminalConnection> openTerminal(
    StoredSession session,
    String sessionName, {
    int cols = 120,
    int rows = 36,
  }) async {
    return _FakeTerminalConnection();
  }

  @override
  Future<FileReadResult> readFile(
    StoredSession session,
    String sessionName,
    String path, {
    bool full = true,
  }) async {
    return const FileReadResult(
      path: '/README.md',
      kind: 'text',
      size: 12,
      truncated: false,
      content: 'hello world',
      language: 'markdown',
      editable: true,
    );
  }

  @override
  Future<void> saveConfig(StoredSession session, String raw) async {}

  @override
  Stream<AgentStreamEvent> streamAgent(
    StoredSession session,
    String sessionName,
    String prompt,
  ) async* {}

  @override
  Future<void> stopAgent(StoredSession session, String sessionName) async {}

  @override
  Future<void> writeFile(
    StoredSession session,
    String sessionName,
    String path,
    String content,
  ) async {}
}

class _FakeTerminalConnection implements TerminalConnection {
  final StreamController<TerminalEvent> _controller =
      StreamController<TerminalEvent>.broadcast();

  @override
  Future<void> close() async {
    await _controller.close();
  }

  @override
  Stream<TerminalEvent> get events => _controller.stream;

  @override
  void resize({required int cols, required int rows}) {}

  @override
  void sendInput(String data) {}
}
