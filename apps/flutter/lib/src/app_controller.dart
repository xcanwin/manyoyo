import 'dart:async';

import 'package:flutter/foundation.dart';

import 'models.dart';
import 'repository.dart';
import 'session_storage.dart';

enum WorkspacePane { conversation, files, terminal, config }

class ManyoyoAppController extends ChangeNotifier {
  ManyoyoAppController({
    required ManyoyoRepository repository,
    required ManyoyoSessionStorage storage,
  }) : _repository = repository,
       _storage = storage;

  final ManyoyoRepository _repository;
  final ManyoyoSessionStorage _storage;

  bool booting = true;
  bool loggingIn = false;
  bool loadingSessions = false;
  bool loadingSessionContent = false;
  bool streamingAgent = false;
  bool stoppingAgent = false;
  bool loadingFiles = false;
  bool savingFile = false;
  bool loadingConfig = false;
  bool savingConfig = false;
  bool creatingSession = false;
  bool connectingTerminal = false;

  String loginError = '';
  String workspaceError = '';
  String fileError = '';
  String configError = '';
  String terminalError = '';
  String terminalStatus = '';
  String liveTrace = '';

  StoredSession? _session;
  String draftBaseUrl = '';
  String draftUsername = '';
  List<SessionSummary> sessions = const <SessionSummary>[];
  String activeSessionName = '';
  SessionDetail? activeSessionDetail;
  List<MessageItem> messages = const <MessageItem>[];
  WorkspacePane pane = WorkspacePane.conversation;
  FileListResult? fileList;
  FileReadResult? fileRead;
  ConfigSnapshot? configSnapshot;
  String terminalOutput = '';

  TerminalConnection? _terminalConnection;
  StreamSubscription<TerminalEvent>? _terminalSubscription;

  bool get isAuthenticated => _session?.isAuthenticated ?? false;

  StoredSession? get session => _session;

  Future<void> initialize() async {
    booting = true;
    notifyListeners();
    final stored = await _storage.load();
    if (stored != null) {
      draftBaseUrl = stored.baseUrl;
      draftUsername = stored.username;
      if (stored.isAuthenticated) {
        _session = stored;
        try {
          await refreshSessions();
        } on ManyoyoApiException catch (error) {
          if (error.unauthorized) {
            loginError = '登录态已失效，请重新登录。';
            _session = stored.copyWith(cookie: '');
          } else {
            workspaceError = error.message;
          }
        } catch (error) {
          workspaceError = error.toString();
        }
      }
    }
    booting = false;
    notifyListeners();
  }

  Future<void> login({
    required String baseUrl,
    required String username,
    required String password,
  }) async {
    loggingIn = true;
    loginError = '';
    notifyListeners();
    try {
      final nextSession = await _repository.login(
        baseUrl: baseUrl,
        username: username,
        password: password,
      );
      _session = nextSession;
      draftBaseUrl = nextSession.baseUrl;
      draftUsername = nextSession.username;
      await _storage.save(nextSession);
      await refreshSessions();
    } on ManyoyoApiException catch (error) {
      loginError = error.message;
    } catch (error) {
      loginError = error.toString();
    } finally {
      loggingIn = false;
      notifyListeners();
    }
  }

  Future<void> logout() async {
    final current = _session;
    if (current == null) {
      return;
    }
    try {
      if (current.isAuthenticated) {
        await _repository.logout(current);
      }
    } catch (_) {
      // Keep logout resilient even when server is unreachable.
    }
    await _closeTerminal();
    await _storage.save(current.copyWith(cookie: ''));
    _session = null;
    sessions = const <SessionSummary>[];
    activeSessionName = '';
    activeSessionDetail = null;
    messages = const <MessageItem>[];
    fileList = null;
    fileRead = null;
    configSnapshot = null;
    liveTrace = '';
    terminalOutput = '';
    terminalError = '';
    terminalStatus = '';
    pane = WorkspacePane.conversation;
    notifyListeners();
  }

  Future<void> refreshSessions({String? preferredSessionName}) async {
    final current = _requireSession();
    loadingSessions = true;
    workspaceError = '';
    notifyListeners();
    try {
      final nextSessions = await _repository.fetchSessions(current);
      sessions = nextSessions;
      final activeName = preferredSessionName?.trim();
      if (activeName != null &&
          activeName.isNotEmpty &&
          nextSessions.any((SessionSummary item) => item.name == activeName)) {
        activeSessionName = activeName;
      } else if (activeSessionName.isNotEmpty &&
          nextSessions.any(
            (SessionSummary item) => item.name == activeSessionName,
          )) {
        // keep current
      } else {
        activeSessionName = nextSessions.isEmpty ? '' : nextSessions.first.name;
      }
      if (activeSessionName.isEmpty) {
        activeSessionDetail = null;
        messages = const <MessageItem>[];
        fileList = null;
        fileRead = null;
        await _closeTerminal();
      } else {
        await loadActiveSession();
      }
    } finally {
      loadingSessions = false;
      notifyListeners();
    }
  }

  Future<void> loadActiveSession() async {
    final current = _requireSession();
    if (activeSessionName.isEmpty) {
      return;
    }
    loadingSessionContent = true;
    workspaceError = '';
    fileError = '';
    terminalError = '';
    notifyListeners();
    try {
      final detailFuture = _repository.fetchSessionDetail(
        current,
        activeSessionName,
      );
      final messagesFuture = _repository.fetchMessages(
        current,
        activeSessionName,
      );
      final filesFuture = _repository.listFiles(current, activeSessionName, '/');
      final results = await Future.wait<Object>(<Future<Object>>[
        detailFuture,
        messagesFuture,
        filesFuture,
      ]);
      activeSessionDetail = results[0] as SessionDetail;
      messages = results[1] as List<MessageItem>;
      fileList = results[2] as FileListResult;
      fileRead = null;
      liveTrace = '';
      if (pane == WorkspacePane.terminal) {
        await connectTerminal();
      }
    } on ManyoyoApiException catch (error) {
      workspaceError = error.message;
    } catch (error) {
      workspaceError = error.toString();
    } finally {
      loadingSessionContent = false;
      notifyListeners();
    }
  }

  Future<void> selectSession(String sessionName) async {
    if (activeSessionName == sessionName) {
      return;
    }
    activeSessionName = sessionName;
    await _closeTerminal();
    await loadActiveSession();
  }

  Future<void> setPane(WorkspacePane nextPane) async {
    if (pane == nextPane) {
      return;
    }
    pane = nextPane;
    notifyListeners();
    if (nextPane == WorkspacePane.config) {
      await loadConfig();
    }
    if (nextPane == WorkspacePane.terminal) {
      await connectTerminal();
    }
  }

  Future<void> sendPrompt(String prompt) async {
    final current = _requireSession();
    final normalizedPrompt = prompt.trim();
    if (activeSessionName.isEmpty || normalizedPrompt.isEmpty) {
      return;
    }
    final now = DateTime.now().toIso8601String();
    final optimisticUser = MessageItem(
      id: 'local-user-$now',
      role: 'user',
      content: normalizedPrompt,
      timestamp: now,
      pending: true,
      mode: 'agent',
    );
    final optimisticAssistant = MessageItem(
      id: 'local-assistant-$now',
      role: 'assistant',
      content: '',
      timestamp: now,
      pending: true,
      mode: 'agent',
    );
    messages = <MessageItem>[
      ...messages,
      optimisticUser,
      optimisticAssistant,
    ];
    streamingAgent = true;
    liveTrace = '';
    notifyListeners();

    try {
      await for (final AgentStreamEvent event in _repository.streamAgent(
        current,
        activeSessionName,
        normalizedPrompt,
      )) {
        if (event.type == 'trace' && event.text.isNotEmpty) {
          liveTrace = liveTrace.isEmpty
              ? event.text
              : '$liveTrace\n${event.text}';
        }
        if (event.type == 'content_delta') {
          messages = <MessageItem>[
            ...messages.take(messages.length - 1),
            optimisticAssistant.copyWith(content: event.content, pending: true),
          ];
        }
        if (event.type == 'error' && event.error.isNotEmpty) {
          workspaceError = event.error;
        }
      }
      await loadActiveSession();
    } on ManyoyoApiException catch (error) {
      workspaceError = error.message;
    } catch (error) {
      workspaceError = error.toString();
    } finally {
      streamingAgent = false;
      notifyListeners();
    }
  }

  Future<void> stopAgent() async {
    final current = _requireSession();
    if (activeSessionName.isEmpty) {
      return;
    }
    stoppingAgent = true;
    notifyListeners();
    try {
      await _repository.stopAgent(current, activeSessionName);
    } on ManyoyoApiException catch (error) {
      workspaceError = error.message;
    } catch (error) {
      workspaceError = error.toString();
    } finally {
      stoppingAgent = false;
      notifyListeners();
    }
  }

  Future<void> openDirectory(String path) async {
    final current = _requireSession();
    if (activeSessionName.isEmpty) {
      return;
    }
    loadingFiles = true;
    fileError = '';
    notifyListeners();
    try {
      fileList = await _repository.listFiles(current, activeSessionName, path);
    } on ManyoyoApiException catch (error) {
      fileError = error.message;
    } catch (error) {
      fileError = error.toString();
    } finally {
      loadingFiles = false;
      notifyListeners();
    }
  }

  Future<void> openFile(String path) async {
    final current = _requireSession();
    if (activeSessionName.isEmpty) {
      return;
    }
    loadingFiles = true;
    fileError = '';
    notifyListeners();
    try {
      fileRead = await _repository.readFile(current, activeSessionName, path);
    } on ManyoyoApiException catch (error) {
      fileError = error.message;
    } catch (error) {
      fileError = error.toString();
    } finally {
      loadingFiles = false;
      notifyListeners();
    }
  }

  Future<void> saveOpenedFile(String content) async {
    final current = _requireSession();
    final openedFile = fileRead;
    if (activeSessionName.isEmpty || openedFile == null || !openedFile.editable) {
      return;
    }
    savingFile = true;
    fileError = '';
    notifyListeners();
    try {
      await _repository.writeFile(
        current,
        activeSessionName,
        openedFile.path,
        content,
      );
      fileRead = await _repository.readFile(
        current,
        activeSessionName,
        openedFile.path,
      );
      await openDirectory(fileList?.path ?? '/');
    } on ManyoyoApiException catch (error) {
      fileError = error.message;
    } catch (error) {
      fileError = error.toString();
    } finally {
      savingFile = false;
      notifyListeners();
    }
  }

  Future<void> createDirectory(String path) async {
    final current = _requireSession();
    if (activeSessionName.isEmpty) {
      return;
    }
    loadingFiles = true;
    fileError = '';
    notifyListeners();
    try {
      await _repository.mkdir(current, activeSessionName, path);
      await openDirectory(fileList?.path ?? '/');
    } on ManyoyoApiException catch (error) {
      fileError = error.message;
    } catch (error) {
      fileError = error.toString();
    } finally {
      loadingFiles = false;
      notifyListeners();
    }
  }

  Future<void> loadConfig() async {
    final current = _requireSession();
    loadingConfig = true;
    configError = '';
    notifyListeners();
    try {
      configSnapshot = await _repository.fetchConfig(current);
    } on ManyoyoApiException catch (error) {
      configError = error.message;
    } catch (error) {
      configError = error.toString();
    } finally {
      loadingConfig = false;
      notifyListeners();
    }
  }

  Future<void> saveConfig(String raw) async {
    final current = _requireSession();
    savingConfig = true;
    configError = '';
    notifyListeners();
    try {
      await _repository.saveConfig(current, raw);
      configSnapshot = await _repository.fetchConfig(current);
    } on ManyoyoApiException catch (error) {
      configError = error.message;
    } catch (error) {
      configError = error.toString();
    } finally {
      savingConfig = false;
      notifyListeners();
    }
  }

  Future<CreateSessionSeed> loadCreateSessionSeed() async {
    return _repository.loadCreateSessionSeed(_requireSession());
  }

  Future<void> createSession(CreateSessionDraft draft) async {
    final current = _requireSession();
    creatingSession = true;
    workspaceError = '';
    notifyListeners();
    try {
      final name = await _repository.createSession(current, draft);
      await refreshSessions(preferredSessionName: name);
    } on ManyoyoApiException catch (error) {
      workspaceError = error.message;
    } catch (error) {
      workspaceError = error.toString();
    } finally {
      creatingSession = false;
      notifyListeners();
    }
  }

  Future<void> connectTerminal() async {
    final current = _requireSession();
    if (activeSessionName.isEmpty) {
      return;
    }
    await _closeTerminal();
    connectingTerminal = true;
    terminalError = '';
    terminalStatus = 'connecting';
    terminalOutput = '';
    notifyListeners();
    try {
      final connection = await _repository.openTerminal(
        current,
        activeSessionName,
      );
      _terminalConnection = connection;
      _terminalSubscription = connection.events.listen(_handleTerminalEvent);
      terminalStatus = 'ready';
    } on ManyoyoApiException catch (error) {
      terminalError = error.message;
      terminalStatus = 'error';
    } catch (error) {
      terminalError = error.toString();
      terminalStatus = 'error';
    } finally {
      connectingTerminal = false;
      notifyListeners();
    }
  }

  void sendTerminalLine(String line) {
    _terminalConnection?.sendInput('$line\n');
  }

  void sendTerminalControlC() {
    _terminalConnection?.sendInput('\u0003');
  }

  void _handleTerminalEvent(TerminalEvent event) {
    if (event.type == 'output' && event.data.isNotEmpty) {
      final next = '$terminalOutput${event.data}';
      terminalOutput = next.length > 32000
          ? next.substring(next.length - 32000)
          : next;
    }
    if (event.type == 'status' && event.phase.isNotEmpty) {
      terminalStatus = event.phase;
    }
    if (event.type == 'error' && event.error.isNotEmpty) {
      terminalError = event.error;
      terminalStatus = 'error';
    }
    notifyListeners();
  }

  StoredSession _requireSession() {
    final current = _session;
    if (current == null || !current.isAuthenticated) {
      throw ManyoyoApiException('当前未登录');
    }
    return current;
  }

  Future<void> _closeTerminal() async {
    await _terminalSubscription?.cancel();
    _terminalSubscription = null;
    if (_terminalConnection != null) {
      await _terminalConnection!.close();
      _terminalConnection = null;
    }
  }

  @override
  void dispose() {
    unawaited(_closeTerminal());
    super.dispose();
  }
}
