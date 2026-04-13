import 'package:flutter/material.dart';

import 'app_controller.dart';
import 'models.dart';

class ManyoyoApp extends StatelessWidget {
  const ManyoyoApp({required this.controller, super.key});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (BuildContext context, _) {
        return MaterialApp(
          title: 'MANYOYO Flutter',
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            useMaterial3: true,
            colorScheme: ColorScheme.fromSeed(
              seedColor: const Color(0xFF155E4A),
              brightness: Brightness.light,
            ),
            scaffoldBackgroundColor: const Color(0xFFF2EFE8),
          ),
          home: controller.booting
              ? const _BootScreen()
              : controller.isAuthenticated
              ? _WorkspaceScreen(
                  key: ValueKey<String>(
                    'workspace-${controller.session?.baseUrl ?? ''}',
                  ),
                  controller: controller,
                )
              : _LoginScreen(
                  key: ValueKey<String>(
                    'login-${controller.draftBaseUrl}-${controller.draftUsername}',
                  ),
                  controller: controller,
                ),
        );
      },
    );
  }
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('正在初始化 MANYOYO Flutter…'),
          ],
        ),
      ),
    );
  }
}

class _LoginScreen extends StatefulWidget {
  const _LoginScreen({required this.controller, super.key});

  final ManyoyoAppController controller;

  @override
  State<_LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<_LoginScreen> {
  late final TextEditingController _baseUrlController;
  late final TextEditingController _usernameController;
  late final TextEditingController _passwordController;

  @override
  void initState() {
    super.initState();
    _baseUrlController = TextEditingController(
      text: widget.controller.draftBaseUrl,
    );
    _usernameController = TextEditingController(
      text: widget.controller.draftUsername,
    );
    _passwordController = TextEditingController();
  }

  @override
  void dispose() {
    _baseUrlController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'MANYOYO 原生工作台',
                      style: textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      '纯 Flutter UI，直接对接 MANYOYO 服务端接口，不再依赖网页壳。',
                      style: textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 24),
                    TextField(
                      controller: _baseUrlController,
                      decoration: const InputDecoration(
                        labelText: '服务地址',
                        hintText: 'http://127.0.0.1:3000',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _usernameController,
                      decoration: const InputDecoration(
                        labelText: '用户名',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _passwordController,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: '密码',
                        border: OutlineInputBorder(),
                      ),
                      onSubmitted: (_) => _submit(),
                    ),
                    const SizedBox(height: 16),
                    if (controller.loginError.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          controller.loginError,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: controller.loggingIn ? null : _submit,
                        child: Text(
                          controller.loggingIn ? '登录中…' : '登录 MANYOYO',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _submit() {
    widget.controller.login(
      baseUrl: _baseUrlController.text,
      username: _usernameController.text,
      password: _passwordController.text,
    );
  }
}

class _WorkspaceScreen extends StatefulWidget {
  const _WorkspaceScreen({required this.controller, super.key});

  final ManyoyoAppController controller;

  @override
  State<_WorkspaceScreen> createState() => _WorkspaceScreenState();
}

class _WorkspaceScreenState extends State<_WorkspaceScreen> {
  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final wide = constraints.maxWidth >= 980;
        final sessionPanel = _SessionList(controller: controller);
        return Scaffold(
          drawer: wide ? null : Drawer(child: SafeArea(child: sessionPanel)),
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(controller.activeSessionName.isEmpty
                    ? 'MANYOYO Flutter'
                    : controller.activeSessionName),
                Text(
                  controller.session?.baseUrl ?? '',
                  style: Theme.of(
                    context,
                  ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w400),
                ),
              ],
            ),
            actions: [
              IconButton(
                tooltip: '刷新',
                onPressed: controller.loadingSessions
                    ? null
                    : controller.refreshSessions,
                icon: const Icon(Icons.refresh),
              ),
              IconButton(
                tooltip: '新建会话',
                onPressed: controller.creatingSession ? null : _openCreateDialog,
                icon: const Icon(Icons.add_box_outlined),
              ),
              IconButton(
                tooltip: '退出登录',
                onPressed: controller.logout,
                icon: const Icon(Icons.logout),
              ),
            ],
          ),
          body: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: SegmentedButton<WorkspacePane>(
                        segments: const [
                          ButtonSegment<WorkspacePane>(
                            value: WorkspacePane.conversation,
                            label: Text('会话'),
                            icon: Icon(Icons.chat_bubble_outline),
                          ),
                          ButtonSegment<WorkspacePane>(
                            value: WorkspacePane.files,
                            label: Text('文件'),
                            icon: Icon(Icons.folder_open_outlined),
                          ),
                          ButtonSegment<WorkspacePane>(
                            value: WorkspacePane.terminal,
                            label: Text('终端'),
                            icon: Icon(Icons.terminal),
                          ),
                          ButtonSegment<WorkspacePane>(
                            value: WorkspacePane.config,
                            label: Text('配置'),
                            icon: Icon(Icons.settings_outlined),
                          ),
                        ],
                        selected: <WorkspacePane>{controller.pane},
                        onSelectionChanged: (Set<WorkspacePane> value) {
                          controller.setPane(value.first);
                        },
                      ),
                    ),
                  ],
                ),
              ),
              if (controller.workspaceError.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: _Banner(
                    color: const Color(0xFFFCE8E6),
                    textColor: const Color(0xFFB42318),
                    text: controller.workspaceError,
                  ),
                ),
              Expanded(
                child: wide
                    ? Row(
                        children: [
                          SizedBox(width: 320, child: sessionPanel),
                          const VerticalDivider(width: 1),
                          Expanded(
                            child: _WorkspacePane(controller: controller),
                          ),
                        ],
                      )
                    : _WorkspacePane(controller: controller),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _openCreateDialog() async {
    final controller = widget.controller;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final seed = await controller.loadCreateSessionSeed();
      if (!mounted) {
        return;
      }
      await showDialog<void>(
        context: context,
        builder: (BuildContext context) {
          return _CreateSessionDialog(controller: controller, seed: seed);
        },
      );
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text('加载创建表单失败：$error')),
      );
    }
  }
}

class _WorkspacePane extends StatelessWidget {
  const _WorkspacePane({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      child: switch (controller.pane) {
        WorkspacePane.conversation => _ConversationPane(controller: controller),
        WorkspacePane.files => _FilesPane(controller: controller),
        WorkspacePane.terminal => _TerminalPane(controller: controller),
        WorkspacePane.config => _ConfigPane(controller: controller),
      },
    );
  }
}

class _SessionList extends StatelessWidget {
  const _SessionList({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    if (controller.loadingSessions && controller.sessions.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (controller.sessions.isEmpty) {
      return const Center(child: Text('当前没有可用会话'));
    }
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: controller.sessions.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (BuildContext context, int index) {
        final session = controller.sessions[index];
        final selected = session.name == controller.activeSessionName;
        return Card(
          color: selected
              ? Theme.of(context).colorScheme.primaryContainer
              : null,
          child: ListTile(
            selected: selected,
            leading: Icon(
              session.status == 'running'
                  ? Icons.play_circle_outline
                  : Icons.history,
            ),
            title: Text(session.name),
            subtitle: Text(
              '${session.agentName} · ${session.status} · ${session.messageCount} 条消息',
            ),
            onTap: () => controller.selectSession(session.name),
          ),
        );
      },
    );
  }
}

class _ConversationPane extends StatefulWidget {
  const _ConversationPane({required this.controller});

  final ManyoyoAppController controller;

  @override
  State<_ConversationPane> createState() => _ConversationPaneState();
}

class _ConversationPaneState extends State<_ConversationPane> {
  late final TextEditingController _promptController;

  @override
  void initState() {
    super.initState();
    _promptController = TextEditingController();
  }

  @override
  void dispose() {
    _promptController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    if (controller.activeSessionName.isEmpty) {
      return const Center(child: Text('先创建或选择一个会话'));
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _DetailHeader(detail: controller.activeSessionDetail),
            const SizedBox(height: 12),
            Expanded(
              child: controller.loadingSessionContent
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.separated(
                      itemCount: controller.messages.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (BuildContext context, int index) {
                        final message = controller.messages[index];
                        return _MessageCard(message: message);
                      },
                    ),
            ),
            if (controller.liveTrace.isNotEmpty) ...[
              const SizedBox(height: 12),
              _Banner(
                color: const Color(0xFFEAF3FF),
                textColor: const Color(0xFF175CD3),
                text: controller.liveTrace,
              ),
            ],
            const SizedBox(height: 12),
            TextField(
              controller: _promptController,
              minLines: 3,
              maxLines: 6,
              decoration: const InputDecoration(
                labelText: '发送给 AGENT',
                hintText: '输入任务描述，客户端会直接走 /agent/stream。',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: controller.streamingAgent
                        ? null
                        : () async {
                            final prompt = _promptController.text;
                            _promptController.clear();
                            await controller.sendPrompt(prompt);
                          },
                    child: Text(
                      controller.streamingAgent ? '运行中…' : '发送',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton(
                    onPressed: controller.stoppingAgent || !controller.streamingAgent
                        ? null
                        : controller.stopAgent,
                    child: Text(
                      controller.stoppingAgent ? '停止中…' : '停止',
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _FilesPane extends StatefulWidget {
  const _FilesPane({required this.controller});

  final ManyoyoAppController controller;

  @override
  State<_FilesPane> createState() => _FilesPaneState();
}

class _FilesPaneState extends State<_FilesPane> {
  late final TextEditingController _editorController;
  String _lastPath = '';

  @override
  void initState() {
    super.initState();
    _editorController = TextEditingController();
  }

  @override
  void didUpdateWidget(covariant _FilesPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    final currentPath = widget.controller.fileRead?.path ?? '';
    if (currentPath != _lastPath) {
      _lastPath = currentPath;
      _editorController.text = widget.controller.fileRead?.content ?? '';
    }
  }

  @override
  void dispose() {
    _editorController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    if (controller.activeSessionName.isEmpty) {
      return const Center(child: Text('先选择会话再浏览文件'));
    }
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final wide = constraints.maxWidth >= 900;
        final browser = _FileBrowser(controller: controller, onCreateDir: _createDir);
        final editor = _FileEditor(
          controller: controller,
          editorController: _editorController,
        );
        return wide
            ? Row(
                children: [
                  SizedBox(width: 320, child: browser),
                  const SizedBox(width: 12),
                  Expanded(child: editor),
                ],
              )
            : Column(
                children: [
                  SizedBox(height: 280, child: browser),
                  const SizedBox(height: 12),
                  Expanded(child: editor),
                ],
              );
      },
    );
  }

  Future<void> _createDir() async {
    final controller = widget.controller;
    final nameController = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: const Text('创建目录'),
          content: TextField(
            controller: nameController,
            decoration: const InputDecoration(
              labelText: '目录名',
              border: OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () =>
                  Navigator.of(context).pop(nameController.text.trim()),
              child: const Text('创建'),
            ),
          ],
        );
      },
    );
    if (result == null || result.isEmpty) {
      return;
    }
    final basePath = controller.fileList?.path ?? '/';
    final targetPath = basePath == '/' ? '/$result' : '$basePath/$result';
    await controller.createDirectory(targetPath);
  }
}

class _FileBrowser extends StatelessWidget {
  const _FileBrowser({required this.controller, required this.onCreateDir});

  final ManyoyoAppController controller;
  final Future<void> Function() onCreateDir;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    controller.fileList?.path ?? '/',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: '刷新目录',
                  onPressed: controller.loadingFiles
                      ? null
                      : () => controller.openDirectory(
                          controller.fileList?.path ?? '/',
                        ),
                  icon: const Icon(Icons.refresh),
                ),
                IconButton(
                  tooltip: '新建目录',
                  onPressed: controller.loadingFiles ? null : onCreateDir,
                  icon: const Icon(Icons.create_new_folder_outlined),
                ),
              ],
            ),
            if (controller.fileError.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  controller.fileError,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            Expanded(
              child: controller.loadingFiles && controller.fileList == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.builder(
                      itemCount:
                          (controller.fileList?.entries.length ?? 0) +
                          ((controller.fileList?.parentPath ?? '').isEmpty
                              ? 0
                              : 1),
                      itemBuilder: (BuildContext context, int index) {
                        final parentPath = controller.fileList?.parentPath ?? '';
                        if (parentPath.isNotEmpty && index == 0) {
                          return ListTile(
                            leading: const Icon(Icons.arrow_upward),
                            title: const Text('..'),
                            onTap: () => controller.openDirectory(parentPath),
                          );
                        }
                        final offset = parentPath.isNotEmpty ? 1 : 0;
                        final entry = controller.fileList!.entries[index - offset];
                        final isDir = entry.kind == 'directory';
                        return ListTile(
                          leading: Icon(
                            isDir
                                ? Icons.folder_outlined
                                : Icons.insert_drive_file_outlined,
                          ),
                          title: Text(entry.name),
                          subtitle: Text(entry.path),
                          onTap: () => isDir
                              ? controller.openDirectory(entry.path)
                              : controller.openFile(entry.path),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _FileEditor extends StatelessWidget {
  const _FileEditor({
    required this.controller,
    required this.editorController,
  });

  final ManyoyoAppController controller;
  final TextEditingController editorController;

  @override
  Widget build(BuildContext context) {
    final file = controller.fileRead;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: file == null
            ? const Center(child: Text('从左侧选择一个文件'))
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    file.path,
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    file.isText
                        ? '语言：${file.language} · ${file.size} bytes'
                        : '当前文件不是可编辑文本文件',
                  ),
                  const SizedBox(height: 12),
                  Expanded(
                    child: file.isText
                        ? TextField(
                            controller: editorController,
                            expands: true,
                            maxLines: null,
                            minLines: null,
                            style: const TextStyle(fontFamily: 'monospace'),
                            decoration: const InputDecoration(
                              border: OutlineInputBorder(),
                            ),
                          )
                        : const Center(child: Text('暂不支持二进制文件预览')),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: !file.editable || controller.savingFile
                        ? null
                        : () => controller.saveOpenedFile(editorController.text),
                    child: Text(controller.savingFile ? '保存中…' : '保存文件'),
                  ),
                ],
              ),
      ),
    );
  }
}

class _TerminalPane extends StatefulWidget {
  const _TerminalPane({required this.controller});

  final ManyoyoAppController controller;

  @override
  State<_TerminalPane> createState() => _TerminalPaneState();
}

class _TerminalPaneState extends State<_TerminalPane> {
  late final TextEditingController _inputController;

  @override
  void initState() {
    super.initState();
    _inputController = TextEditingController();
  }

  @override
  void dispose() {
    _inputController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    if (controller.activeSessionName.isEmpty) {
      return const Center(child: Text('先选择会话再连接终端'));
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text('状态：${controller.terminalStatus}')),
                IconButton(
                  tooltip: '重连终端',
                  onPressed: controller.connectingTerminal
                      ? null
                      : controller.connectTerminal,
                  icon: const Icon(Icons.refresh),
                ),
                IconButton(
                  tooltip: '发送 Ctrl+C',
                  onPressed: controller.sendTerminalControlC,
                  icon: const Icon(Icons.cancel_presentation_outlined),
                ),
              ],
            ),
            if (controller.terminalError.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  controller.terminalError,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            Expanded(
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF0E1A17),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: SingleChildScrollView(
                  child: SelectableText(
                    controller.terminalOutput.isEmpty
                        ? '终端输出会显示在这里。'
                        : controller.terminalOutput,
                    style: const TextStyle(
                      color: Color(0xFFE4FFF3),
                      fontFamily: 'monospace',
                      height: 1.35,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _inputController,
                    decoration: const InputDecoration(
                      labelText: '终端输入',
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton(onPressed: _submit, child: const Text('发送')),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _submit() {
    final text = _inputController.text;
    if (text.trim().isEmpty) {
      return;
    }
    widget.controller.sendTerminalLine(text);
    _inputController.clear();
  }
}

class _ConfigPane extends StatefulWidget {
  const _ConfigPane({required this.controller});

  final ManyoyoAppController controller;

  @override
  State<_ConfigPane> createState() => _ConfigPaneState();
}

class _ConfigPaneState extends State<_ConfigPane> {
  late final TextEditingController _configController;
  String _lastConfigPath = '';

  @override
  void initState() {
    super.initState();
    _configController = TextEditingController();
  }

  @override
  void didUpdateWidget(covariant _ConfigPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    final path = widget.controller.configSnapshot?.path ?? '';
    if (path != _lastConfigPath) {
      _lastConfigPath = path;
      _configController.text = widget.controller.configSnapshot?.raw ?? '';
    }
  }

  @override
  void dispose() {
    _configController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    controller.configSnapshot?.path ?? '~/.manyoyo/manyoyo.json',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: '刷新配置',
                  onPressed: controller.loadingConfig ? null : controller.loadConfig,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            if ((controller.configSnapshot?.notice ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(controller.configSnapshot!.notice),
              ),
            if (controller.configError.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  controller.configError,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            Expanded(
              child: controller.loadingConfig && controller.configSnapshot == null
                  ? const Center(child: CircularProgressIndicator())
                  : TextField(
                      controller: _configController,
                      expands: true,
                      maxLines: null,
                      minLines: null,
                      style: const TextStyle(fontFamily: 'monospace'),
                      decoration: const InputDecoration(
                        border: OutlineInputBorder(),
                      ),
                    ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: controller.savingConfig
                  ? null
                  : () => controller.saveConfig(_configController.text),
              child: Text(controller.savingConfig ? '保存中…' : '保存配置'),
            ),
          ],
        ),
      ),
    );
  }
}

class _CreateSessionDialog extends StatefulWidget {
  const _CreateSessionDialog({
    required this.controller,
    required this.seed,
  });

  final ManyoyoAppController controller;
  final CreateSessionSeed seed;

  @override
  State<_CreateSessionDialog> createState() => _CreateSessionDialogState();
}

class _CreateSessionDialogState extends State<_CreateSessionDialog> {
  late final TextEditingController _containerNameController;
  late final TextEditingController _hostPathController;
  late final TextEditingController _containerPathController;
  late final TextEditingController _imageNameController;
  late final TextEditingController _imageVersionController;
  late final TextEditingController _containerModeController;
  late final TextEditingController _shellPrefixController;
  late final TextEditingController _shellController;
  late final TextEditingController _shellSuffixController;
  late final TextEditingController _agentPromptCommandController;
  late final TextEditingController _yoloController;
  String _run = '';

  @override
  void initState() {
    super.initState();
    _containerNameController = TextEditingController();
    _hostPathController = TextEditingController();
    _containerPathController = TextEditingController();
    _imageNameController = TextEditingController();
    _imageVersionController = TextEditingController();
    _containerModeController = TextEditingController();
    _shellPrefixController = TextEditingController();
    _shellController = TextEditingController();
    _shellSuffixController = TextEditingController();
    _agentPromptCommandController = TextEditingController();
    _yoloController = TextEditingController();
    _applyDefaults();
  }

  @override
  void dispose() {
    _containerNameController.dispose();
    _hostPathController.dispose();
    _containerPathController.dispose();
    _imageNameController.dispose();
    _imageVersionController.dispose();
    _containerModeController.dispose();
    _shellPrefixController.dispose();
    _shellController.dispose();
    _shellSuffixController.dispose();
    _agentPromptCommandController.dispose();
    _yoloController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final runNames = widget.seed.runs.keys.toList()..sort();
    return AlertDialog(
      title: const Text('新建会话'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: _run,
                decoration: const InputDecoration(
                  labelText: 'run',
                  border: OutlineInputBorder(),
                ),
                items: <DropdownMenuItem<String>>[
                  const DropdownMenuItem<String>(
                    value: '',
                    child: Text('(不使用 run)'),
                  ),
                  ...runNames.map(
                    (String item) => DropdownMenuItem<String>(
                      value: item,
                      child: Text(item),
                    ),
                  ),
                ],
                onChanged: (String? value) {
                  setState(() {
                    _run = value ?? '';
                    _applyDefaults();
                  });
                },
              ),
              const SizedBox(height: 12),
              _field(_containerNameController, 'containerName'),
              const SizedBox(height: 12),
              _field(_hostPathController, 'hostPath'),
              const SizedBox(height: 12),
              _field(_containerPathController, 'containerPath'),
              const SizedBox(height: 12),
              _field(_imageNameController, 'imageName'),
              const SizedBox(height: 12),
              _field(_imageVersionController, 'imageVersion'),
              const SizedBox(height: 12),
              _field(_containerModeController, 'containerMode'),
              const SizedBox(height: 12),
              _field(_shellPrefixController, 'shellPrefix'),
              const SizedBox(height: 12),
              _field(_shellController, 'shell'),
              const SizedBox(height: 12),
              _field(_shellSuffixController, 'shellSuffix'),
              const SizedBox(height: 12),
              _field(_agentPromptCommandController, 'agentPromptCommand'),
              const SizedBox(height: 12),
              _field(_yoloController, 'yolo'),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: widget.controller.creatingSession
              ? null
              : () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: widget.controller.creatingSession ? null : _submit,
          child: Text(widget.controller.creatingSession ? '创建中…' : '创建'),
        ),
      ],
    );
  }

  TextField _field(TextEditingController controller, String label) {
    return TextField(
      controller: controller,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
    );
  }

  void _applyDefaults() {
    final defaults = Map<String, dynamic>.from(widget.seed.defaults);
    final runConfig = widget.seed.runs[_run] ?? const <String, dynamic>{};
    defaults.addAll(runConfig);
    _containerNameController.text = asString(defaults['containerName']);
    _hostPathController.text = asString(defaults['hostPath']);
    _containerPathController.text = asString(defaults['containerPath']);
    _imageNameController.text = asString(defaults['imageName']);
    _imageVersionController.text = asString(defaults['imageVersion']);
    _containerModeController.text = asString(defaults['containerMode']);
    _shellPrefixController.text = asString(defaults['shellPrefix']);
    _shellController.text = asString(defaults['shell']);
    _shellSuffixController.text = asString(defaults['shellSuffix']);
    _agentPromptCommandController.text = asString(defaults['agentPromptCommand']);
    _yoloController.text = asString(defaults['yolo']);
  }

  Future<void> _submit() async {
    await widget.controller.createSession(
      CreateSessionDraft(
        run: _run,
        containerName: _containerNameController.text,
        hostPath: _hostPathController.text,
        containerPath: _containerPathController.text,
        imageName: _imageNameController.text,
        imageVersion: _imageVersionController.text,
        containerMode: _containerModeController.text,
        shellPrefix: _shellPrefixController.text,
        shell: _shellController.text,
        shellSuffix: _shellSuffixController.text,
        agentPromptCommand: _agentPromptCommandController.text,
        yolo: _yoloController.text,
      ),
    );
    if (mounted && widget.controller.workspaceError.isEmpty) {
      Navigator.of(context).pop();
    }
  }
}

class _DetailHeader extends StatelessWidget {
  const _DetailHeader({required this.detail});

  final SessionDetail? detail;

  @override
  Widget build(BuildContext context) {
    if (detail == null) {
      return const SizedBox.shrink();
    }
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _InfoChip(label: detail!.status),
        if (detail!.agentProgram.isNotEmpty) _InfoChip(label: detail!.agentProgram),
        if (detail!.hostPath.isNotEmpty) _InfoChip(label: detail!.hostPath),
        if (detail!.containerPath.isNotEmpty) _InfoChip(label: detail!.containerPath),
      ],
    );
  }
}

class _InfoChip extends StatelessWidget {
  const _InfoChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Chip(label: Text(label));
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message});

  final MessageItem message;

  @override
  Widget build(BuildContext context) {
    final tone = switch (message.role) {
      'user' => const Color(0xFFE7F1FF),
      'assistant' => const Color(0xFFE9F8EF),
      'system' => const Color(0xFFF5F2E8),
      _ => const Color(0xFFF2F4F7),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tone,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${message.role.toUpperCase()} ${message.pending ? '· pending' : ''}',
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            SelectableText(message.content.isEmpty ? '…' : message.content),
            if (message.timestamp.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(message.timestamp, style: Theme.of(context).textTheme.labelSmall),
            ],
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    required this.color,
    required this.textColor,
    required this.text,
  });

  final Color color;
  final Color textColor;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(12),
      ),
      child: SelectableText(
        text,
        style: TextStyle(color: textColor, fontWeight: FontWeight.w600),
      ),
    );
  }
}
