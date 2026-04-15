import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:manyoyo_flutter/src/app_controller.dart';
import 'package:manyoyo_flutter/src/models.dart';
import 'package:manyoyo_flutter/src/repository.dart';
import 'package:manyoyo_flutter/src/session_storage.dart';

void main() {
  test('controller streams prompt and reloads latest messages', () async {
    final repository = _ControllerFakeRepository();
    final controller = ManyoyoAppController(
      repository: repository,
      storage: _MemoryStorage(
        session: const StoredSession(
          baseUrl: 'http://127.0.0.1:3000',
          username: 'demo',
          cookie: 'manyoyo_web_auth=ok',
        ),
      ),
    );

    await controller.initialize();
    await controller.sendPrompt('实现一个 Flutter 页面');

    expect(repository.lastPrompt, '实现一个 Flutter 页面');
    expect(controller.messages.last.role, 'assistant');
    expect(controller.messages.last.content, '已改为原生消息流。');
    expect(controller.streamingAgent, isFalse);
  });

  test('controller runs command and reloads latest messages', () async {
    final repository = _ControllerFakeRepository();
    final controller = ManyoyoAppController(
      repository: repository,
      storage: _MemoryStorage(
        session: const StoredSession(
          baseUrl: 'http://127.0.0.1:3000',
          username: 'demo',
          cookie: 'manyoyo_web_auth=ok',
        ),
      ),
    );

    await controller.initialize();
    await controller.runCommand('ls -la');

    expect(repository.lastCommand, 'ls -la');
    expect(controller.messages.last.role, 'assistant');
    expect(controller.messages.last.mode, 'command');
    expect(controller.messages.last.content, 'command done');
    expect(controller.runningCommand, isFalse);
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

class _ControllerFakeRepository implements ManyoyoRepository {
  String lastPrompt = '';
  String lastCommand = '';
  final List<MessageItem> _messages = [
    const MessageItem(
      id: 'm1',
      role: 'assistant',
      content: '欢迎使用 MANYOYO。',
      timestamp: '2026-04-14T00:00:00.000Z',
      pending: false,
      mode: 'agent',
    ),
  ];

  @override
  Future<String> createSession(
    StoredSession session,
    CreateSessionDraft draft,
  ) async {
    return 'demo';
  }

  @override
  Future<String> createAgentSession(
    StoredSession session,
    String sessionName,
  ) async {
    return 'demo~agent-2';
  }

  @override
  Future<ConfigSnapshot> fetchConfig(StoredSession session) async {
    return const ConfigSnapshot(
      path: '/tmp/manyoyo.json',
      raw: '{}',
      parsed: {'runs': {}},
      defaults: {'hostPath': '/workspace/demo'},
      parseError: '',
      editable: true,
      notice: '',
    );
  }

  @override
  Future<List<MessageItem>> fetchMessages(
    StoredSession session,
    String sessionName,
  ) async {
    return List<MessageItem>.from(_messages);
  }

  @override
  Future<SessionDetail> fetchSessionDetail(
    StoredSession session,
    String sessionName,
  ) async {
    return const SessionDetail(
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
      latestRole: 'assistant',
      latestTimestamp: '2026-04-14T00:00:00.000Z',
      agentPromptCommand: 'codex',
      containerAgentPromptCommand: '',
      agentPromptCommandOverride: '',
      inferredAgentPromptCommand: 'codex',
      agentPromptSource: 'container',
      lastResumeAt: '',
      lastResumeOk: true,
      lastResumeError: '',
      applied: {'hostPath': '/workspace/demo'},
    );
  }

  @override
  Future<List<SessionSummary>> fetchSessions(StoredSession session) async {
    return const [
      SessionSummary(
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
    return const CreateSessionSeed(defaults: {}, runs: {});
  }

  @override
  Future<FileListResult> listFiles(
    StoredSession session,
    String sessionName,
    String path,
  ) async {
    return const FileListResult(path: '/', parentPath: '', entries: []);
  }

  @override
  Future<void> logout(StoredSession session) async {}

  @override
  Future<void> removeSession(StoredSession session, String sessionName) async {}

  @override
  Future<void> removeSessionWithHistory(
    StoredSession session,
    String sessionName,
  ) async {}

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
      size: 10,
      truncated: false,
      content: 'hello',
      language: 'markdown',
      editable: true,
    );
  }

  @override
  Future<void> saveConfig(StoredSession session, String raw) async {}

  @override
  Future<SessionDetail> saveAgentTemplate(
    StoredSession session,
    String sessionName, {
    String? containerAgentPromptCommand,
    String? agentPromptCommandOverride,
  }) async {
    return fetchSessionDetail(session, sessionName);
  }

  @override
  Future<RunCommandResult> runCommand(
    StoredSession session,
    String sessionName,
    String command,
  ) async {
    lastCommand = command;
    _messages.add(
      MessageItem(
        id: 'm-command-user',
        role: 'user',
        content: command,
        timestamp: '2026-04-14T00:02:00.000Z',
        pending: false,
        mode: 'command',
      ),
    );
    _messages.add(
      const MessageItem(
        id: 'm-command-assistant',
        role: 'assistant',
        content: 'command done',
        timestamp: '2026-04-14T00:02:01.000Z',
        pending: false,
        mode: 'command',
        exitCode: 0,
      ),
    );
    return const RunCommandResult(exitCode: 0, output: 'command done');
  }

  @override
  Stream<AgentStreamEvent> streamAgent(
    StoredSession session,
    String sessionName,
    String prompt,
  ) async* {
    lastPrompt = prompt;
    yield const AgentStreamEvent(
      type: 'trace',
      content: '',
      text: 'Agent 已启动',
      error: '',
      exitCode: null,
      interrupted: false,
    );
    yield const AgentStreamEvent(
      type: 'content_delta',
      content: '已改为原生',
      text: '',
      error: '',
      exitCode: null,
      interrupted: false,
    );
    _messages.add(
      MessageItem(
        id: 'm2',
        role: 'user',
        content: prompt,
        timestamp: '2026-04-14T00:01:00.000Z',
        pending: false,
        mode: 'agent',
      ),
    );
    _messages.add(
      const MessageItem(
        id: 'm3',
        role: 'assistant',
        content: '已改为原生消息流。',
        timestamp: '2026-04-14T00:01:01.000Z',
        pending: false,
        mode: 'agent',
      ),
    );
    yield const AgentStreamEvent(
      type: 'result',
      content: '',
      text: '',
      error: '',
      exitCode: 0,
      interrupted: false,
    );
  }

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
  @override
  Future<void> close() async {}

  @override
  Stream<TerminalEvent> get events => const Stream<TerminalEvent>.empty();

  @override
  void resize({required int cols, required int rows}) {}

  @override
  void sendInput(String data) {}
}
