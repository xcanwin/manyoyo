import 'package:flex_color_scheme/flex_color_scheme.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

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
          themeMode: ThemeMode.light,
          theme: _buildTheme(Brightness.light),
          darkTheme: _buildTheme(Brightness.dark),
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

  ThemeData _buildTheme(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final baseText = GoogleFonts.manropeTextTheme(
      Typography.material2021(platform: TargetPlatform.macOS).black,
    );
    final colorScheme = FlexSchemeColor.from(
      primary: const Color(0xFF0C6849),
      secondary: const Color(0xFFD58438),
      tertiary: const Color(0xFF234E70),
      appBarColor: const Color(0xFFF6F1E7),
      error: const Color(0xFFB9382F),
    );

    return FlexThemeData.light(
      useMaterial3: true,
      colors: colorScheme,
      surfaceMode: FlexSurfaceMode.levelSurfacesLowScaffold,
      blendLevel: 10,
      subThemesData: const FlexSubThemesData(
        blendOnLevel: 12,
        blendOnColors: false,
        cardRadius: 28,
        defaultRadius: 22,
        inputDecoratorRadius: 22,
        inputDecoratorBorderType: FlexInputBorderType.outline,
        navigationRailUseIndicator: true,
        navigationRailLabelType: NavigationRailLabelType.all,
        segmentedButtonRadius: 18,
        tooltipRadius: 14,
      ),
      scaffoldBackground:
          isDark ? const Color(0xFF111615) : const Color(0xFFEAE3D5),
      textTheme: baseText,
      primaryTextTheme: baseText,
      appBarStyle: FlexAppBarStyle.scaffoldBackground,
    ).copyWith(
      cardColor: isDark ? const Color(0xFF1A2220) : const Color(0xFFFBF7F0),
      textTheme: baseText.copyWith(
        displayLarge: GoogleFonts.dmSerifDisplay(
          fontSize: 56,
          height: 0.95,
          color: isDark ? const Color(0xFFF6EEE2) : const Color(0xFF1A1F1D),
        ),
        displayMedium: GoogleFonts.dmSerifDisplay(
          fontSize: 40,
          height: 0.98,
          color: isDark ? const Color(0xFFF6EEE2) : const Color(0xFF1A1F1D),
        ),
        headlineLarge: GoogleFonts.dmSerifDisplay(
          fontSize: 32,
          color: isDark ? const Color(0xFFF6EEE2) : const Color(0xFF1A1F1D),
        ),
        titleLarge: baseText.titleLarge?.copyWith(
          fontWeight: FontWeight.w800,
          letterSpacing: -0.3,
        ),
        titleMedium: baseText.titleMedium?.copyWith(
          fontWeight: FontWeight.w800,
          letterSpacing: -0.2,
        ),
        bodyLarge: baseText.bodyLarge?.copyWith(height: 1.5),
        bodyMedium: baseText.bodyMedium?.copyWith(height: 1.45),
        labelLarge: GoogleFonts.ibmPlexMono(
          fontSize: 13,
          letterSpacing: 0.2,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();

  @override
  Widget build(BuildContext context) {
    return _ShellBackdrop(
      child: Center(
        child: _SurfacePanel(
          width: 360,
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(
                width: 42,
                height: 42,
                child: CircularProgressIndicator(strokeWidth: 3),
              ),
              const SizedBox(height: 18),
              Text(
                '正在初始化 MANYOYO Flutter…',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
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
    final theme = Theme.of(context);
    return _ShellBackdrop(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1080),
            child: _SurfacePanel(
              padding: EdgeInsets.zero,
              child: LayoutBuilder(
                builder: (BuildContext context, BoxConstraints constraints) {
                  final stacked = constraints.maxWidth < 860;
                  final hero = _LoginHero(controller: controller);
                  final form = _LoginForm(
                    controller: controller,
                    baseUrlController: _baseUrlController,
                    usernameController: _usernameController,
                    passwordController: _passwordController,
                    onSubmit: _submit,
                  );
                  if (stacked) {
                    return Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [hero, form],
                    );
                  }
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(flex: 11, child: hero),
                      Expanded(
                        flex: 10,
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            color: theme.colorScheme.surface,
                            border: Border(
                              left: BorderSide(
                                color: theme.colorScheme.outlineVariant,
                              ),
                            ),
                          ),
                          child: form,
                        ),
                      ),
                    ],
                  );
                },
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

class _LoginHero extends StatelessWidget {
  const _LoginHero({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(32, 30, 32, 30),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Color(0xFF15372C),
            Color(0xFF275C46),
            Color(0xFFCE8841),
          ],
        ),
        borderRadius: const BorderRadius.only(
          topLeft: Radius.circular(28),
          bottomLeft: Radius.circular(28),
        ),
      ),
      child: DefaultTextStyle(
        style: theme.textTheme.bodyLarge!.copyWith(color: Colors.white),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Tag(
              label: 'PURE FLUTTER UI',
              color: Colors.white.withValues(alpha: 0.16),
              foreground: Colors.white,
            ),
            const SizedBox(height: 26),
            Text(
              'MANYOYO 原生工作台',
              style: theme.textTheme.displayMedium?.copyWith(
                color: Colors.white,
              ),
            ),
            const SizedBox(height: 14),
            Text(
              '不再复用网页壳。现在的客户端直接接管登录、会话、文件、终端和配置，让桌面端像一个真正的工作台，而不是被塞进容器的网页。',
              style: theme.textTheme.bodyLarge?.copyWith(
                color: Colors.white.withValues(alpha: 0.86),
              ),
            ),
            const SizedBox(height: 28),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: const [
                _StatCard(
                  eyebrow: '工作区',
                  value: '4',
                  caption: '会话 / 文件 / 终端 / 配置',
                ),
                _StatCard(
                  eyebrow: '链路',
                  value: '100%',
                  caption: 'Cookie + API + WebSocket',
                ),
                _StatCard(
                  eyebrow: '方向',
                  value: 'M3',
                  caption: 'Theme token driven',
                ),
              ],
            ),
            const SizedBox(height: 24),
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(22),
                border: Border.all(
                  color: Colors.white.withValues(alpha: 0.18),
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '推荐连接方式',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'manyoyo serve 127.0.0.1:3000 -U demo -P demo123',
                    style: GoogleFonts.ibmPlexMono(
                      fontSize: 13,
                      color: Colors.white.withValues(alpha: 0.92),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LoginForm extends StatelessWidget {
  const _LoginForm({
    required this.controller,
    required this.baseUrlController,
    required this.usernameController,
    required this.passwordController,
    required this.onSubmit,
  });

  final ManyoyoAppController controller;
  final TextEditingController baseUrlController;
  final TextEditingController usernameController;
  final TextEditingController passwordController;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('进入 MANYOYO', style: theme.textTheme.headlineLarge),
          const SizedBox(height: 12),
          Text(
            '输入服务地址与鉴权信息。登录成功后，Flutter 客户端会直接持有会话 Cookie 并进入原生工作区。',
            style: theme.textTheme.bodyLarge,
          ),
          const SizedBox(height: 24),
          TextField(
            controller: baseUrlController,
            decoration: const InputDecoration(
              labelText: '服务地址',
              hintText: 'http://127.0.0.1:3000',
              prefixIcon: Icon(Icons.link_outlined),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: usernameController,
            decoration: const InputDecoration(
              labelText: '用户名',
              prefixIcon: Icon(Icons.person_outline),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: passwordController,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: '密码',
              prefixIcon: Icon(Icons.key_outlined),
            ),
            onSubmitted: (_) => onSubmit(),
          ),
          const SizedBox(height: 18),
          if (controller.loginError.isNotEmpty)
            _ErrorNotice(message: controller.loginError),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: controller.loggingIn ? null : onSubmit,
              icon: Icon(
                controller.loggingIn
                    ? Icons.hourglass_bottom
                    : Icons.arrow_forward_rounded,
              ),
              label: Text(controller.loggingIn ? '登录中…' : '登录 MANYOYO'),
            ),
          ),
        ],
      ),
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
    return _ShellBackdrop(
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final wide = constraints.maxWidth >= 1180;
          final medium = constraints.maxWidth >= 820;
          final sessionList = _SessionList(controller: controller);
          final pane = _WorkspacePane(controller: controller);

          return Scaffold(
            backgroundColor: Colors.transparent,
            drawer: wide ? null : Drawer(child: SafeArea(child: sessionList)),
            body: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  children: [
                    _WorkspaceTopBar(controller: controller),
                    const SizedBox(height: 14),
                    Expanded(
                      child: wide
                          ? Row(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                SizedBox(width: 320, child: sessionList),
                                const SizedBox(width: 14),
                                Expanded(child: pane),
                              ],
                            )
                          : medium
                          ? Column(
                              children: [
                                SizedBox(height: 248, child: sessionList),
                                const SizedBox(height: 14),
                                Expanded(child: pane),
                              ],
                            )
                          : pane,
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _WorkspaceTopBar extends StatelessWidget {
  const _WorkspaceTopBar({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _SurfacePanel(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      controller.activeSessionName.isEmpty
                          ? 'MANYOYO Flutter'
                          : controller.activeSessionName,
                      style: theme.textTheme.headlineLarge,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      controller.session?.baseUrl ?? '',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  _Tag(
                    label:
                        '${controller.sessions.length.toString().padLeft(2, '0')} sessions',
                    color: theme.colorScheme.secondaryContainer,
                    foreground: theme.colorScheme.onSecondaryContainer,
                  ),
                  IconButton.filledTonal(
                    tooltip: '刷新',
                    onPressed: controller.loadingSessions
                        ? null
                        : controller.refreshSessions,
                    icon: const Icon(Icons.refresh),
                  ),
                  IconButton.filledTonal(
                    tooltip: '新建会话',
                    onPressed: controller.creatingSession
                        ? null
                        : () => _openCreate(context),
                    icon: const Icon(Icons.add),
                  ),
                  IconButton.outlined(
                    tooltip: '退出登录',
                    onPressed: controller.logout,
                    icon: const Icon(Icons.logout),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: SegmentedButton<WorkspacePane>(
                  segments: const [
                    ButtonSegment<WorkspacePane>(
                      value: WorkspacePane.conversation,
                      icon: Icon(Icons.auto_awesome_outlined),
                      label: Text('会话'),
                    ),
                    ButtonSegment<WorkspacePane>(
                      value: WorkspacePane.files,
                      icon: Icon(Icons.folder_open_outlined),
                      label: Text('文件'),
                    ),
                    ButtonSegment<WorkspacePane>(
                      value: WorkspacePane.terminal,
                      icon: Icon(Icons.terminal),
                      label: Text('终端'),
                    ),
                    ButtonSegment<WorkspacePane>(
                      value: WorkspacePane.config,
                      icon: Icon(Icons.tune_outlined),
                      label: Text('配置'),
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
          if (controller.workspaceError.isNotEmpty) ...[
            const SizedBox(height: 14),
            _ErrorNotice(message: controller.workspaceError),
          ],
        ],
      ),
    );
  }

  Future<void> _openCreate(BuildContext context) async {
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final seed = await controller.loadCreateSessionSeed();
      if (!context.mounted) {
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
      navigator.maybePop();
    }
  }
}

class _WorkspacePane extends StatelessWidget {
  const _WorkspacePane({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    return switch (controller.pane) {
      WorkspacePane.conversation => _ConversationPane(controller: controller),
      WorkspacePane.files => _FilesPane(controller: controller),
      WorkspacePane.terminal => _TerminalPane(controller: controller),
      WorkspacePane.config => _ConfigPane(controller: controller),
    };
  }
}

class _SessionList extends StatelessWidget {
  const _SessionList({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _SurfacePanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('会话导航', style: theme.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(
            '容器 / Agent / 运行状态',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 14),
          if (controller.loadingSessions && controller.sessions.isEmpty)
            const Expanded(child: Center(child: CircularProgressIndicator()))
          else if (controller.sessions.isEmpty)
            const Expanded(child: Center(child: Text('当前没有可用会话')))
          else
            Expanded(
              child: ListView.separated(
                itemCount: controller.sessions.length,
                separatorBuilder: (_, _) => const SizedBox(height: 10),
                itemBuilder: (BuildContext context, int index) {
                  final item = controller.sessions[index];
                  final selected = item.name == controller.activeSessionName;
                  return InkWell(
                    borderRadius: BorderRadius.circular(20),
                    onTap: () => controller.selectSession(item.name),
                    child: Ink(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(20),
                        color: selected
                            ? theme.colorScheme.primaryContainer
                            : theme.colorScheme.surfaceContainerLow,
                        border: Border.all(
                          color: selected
                              ? theme.colorScheme.primary
                              : theme.colorScheme.outlineVariant,
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                _StatusDot(status: item.status),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    item.name,
                                    style: theme.textTheme.titleMedium,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: [
                                _MiniPill(label: item.agentName),
                                _MiniPill(label: item.status),
                                _MiniPill(label: '${item.messageCount} msg'),
                              ],
                            ),
                            if (item.hostPath.isNotEmpty) ...[
                              const SizedBox(height: 10),
                              Text(
                                item.hostPath,
                                style: GoogleFonts.ibmPlexMono(
                                  fontSize: 11,
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
        ],
      ),
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
      return _EmptyPane(
        title: '先创建或选择一个会话',
        body: '工作区已经就位，下一步是把运行上下文接进来。',
      );
    }
    return _SurfacePanel(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PaneHeader(
            title: 'Conversation',
            subtitle: '流式 Agent 回复、运行轨迹和上下文摘要',
            trailing: _DetailHeader(detail: controller.activeSessionDetail),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: controller.loadingSessionContent
                ? const Center(child: CircularProgressIndicator())
                : ListView.separated(
                    itemCount: controller.messages.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 10),
                    itemBuilder: (BuildContext context, int index) {
                      return _MessageCard(message: controller.messages[index]);
                    },
                  ),
          ),
          if (controller.liveTrace.isNotEmpty) ...[
            const SizedBox(height: 12),
            _TracePanel(trace: controller.liveTrace),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _promptController,
            minLines: 4,
            maxLines: 7,
            decoration: const InputDecoration(
              labelText: '发送给 AGENT',
              hintText: '例如：把登录页改成更适合桌面端的双栏布局。',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: controller.streamingAgent
                      ? null
                      : () async {
                          final prompt = _promptController.text;
                          _promptController.clear();
                          await controller.sendPrompt(prompt);
                        },
                  icon: Icon(
                    controller.streamingAgent
                        ? Icons.hourglass_bottom
                        : Icons.send_rounded,
                  ),
                  label: Text(controller.streamingAgent ? '运行中…' : '发送'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: controller.stoppingAgent || !controller.streamingAgent
                      ? null
                      : controller.stopAgent,
                  icon: const Icon(Icons.stop_circle_outlined),
                  label: Text(controller.stoppingAgent ? '停止中…' : '停止'),
                ),
              ),
            ],
          ),
        ],
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
    final nextPath = widget.controller.fileRead?.path ?? '';
    if (nextPath != _lastPath) {
      _lastPath = nextPath;
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
      return _EmptyPane(
        title: '先选择会话再浏览文件',
        body: '文件树与编辑器会自动绑定当前容器上下文。',
      );
    }
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final wide = constraints.maxWidth >= 980;
        final browser = _FileBrowser(
          controller: controller,
          onCreateDir: _createDir,
        );
        final editor = _FileEditor(
          controller: controller,
          editorController: _editorController,
        );
        return wide
            ? Row(
                children: [
                  SizedBox(width: 340, child: browser),
                  const SizedBox(width: 14),
                  Expanded(child: editor),
                ],
              )
            : Column(
                children: [
                  SizedBox(height: 290, child: browser),
                  const SizedBox(height: 14),
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
            decoration: const InputDecoration(labelText: '目录名'),
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
    final base = controller.fileList?.path ?? '/';
    final target = base == '/' ? '/$result' : '$base/$result';
    await controller.createDirectory(target);
  }
}

class _FileBrowser extends StatelessWidget {
  const _FileBrowser({
    required this.controller,
    required this.onCreateDir,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onCreateDir;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _SurfacePanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PaneHeader(
            title: 'Files',
            subtitle: controller.fileList?.path ?? '/',
            trailing: Wrap(
              spacing: 8,
              children: [
                IconButton.filledTonal(
                  onPressed: controller.loadingFiles
                      ? null
                      : () => controller.openDirectory(
                          controller.fileList?.path ?? '/',
                        ),
                  icon: const Icon(Icons.refresh),
                ),
                IconButton.filledTonal(
                  onPressed: controller.loadingFiles ? null : onCreateDir,
                  icon: const Icon(Icons.create_new_folder_outlined),
                ),
              ],
            ),
          ),
          if (controller.fileError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                controller.fileError,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                  fontWeight: FontWeight.w700,
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
                      final parent = controller.fileList?.parentPath ?? '';
                      if (parent.isNotEmpty && index == 0) {
                        return _FileTile(
                          icon: Icons.arrow_upward_rounded,
                          name: '..',
                          path: parent,
                          onTap: () => controller.openDirectory(parent),
                        );
                      }
                      final offset = parent.isNotEmpty ? 1 : 0;
                      final entry = controller.fileList!.entries[index - offset];
                      final isDir = entry.kind == 'directory';
                      return _FileTile(
                        icon: isDir
                            ? Icons.folder_outlined
                            : Icons.description_outlined,
                        name: entry.name,
                        path: entry.path,
                        onTap: () => isDir
                            ? controller.openDirectory(entry.path)
                            : controller.openFile(entry.path),
                      );
                    },
                  ),
          ),
        ],
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
    final theme = Theme.of(context);
    return _SurfacePanel(
      padding: const EdgeInsets.all(14),
      child: file == null
          ? const _EmptyPane(
              title: '从左侧选择一个文件',
              body: '文本文件会在这里打开，并且可以直接保存回容器。',
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _PaneHeader(
                  title: '编辑器',
                  subtitle: file.path,
                  trailing: _MiniPill(
                    label: file.isText
                        ? '${file.language} · ${file.size} bytes'
                        : 'binary',
                  ),
                ),
                const SizedBox(height: 10),
                Expanded(
                  child: file.isText
                      ? DecoratedBox(
                          decoration: BoxDecoration(
                            color: theme.colorScheme.surfaceContainerLowest,
                            borderRadius: BorderRadius.circular(22),
                            border: Border.all(
                              color: theme.colorScheme.outlineVariant,
                            ),
                          ),
                          child: TextField(
                            controller: editorController,
                            expands: true,
                            maxLines: null,
                            minLines: null,
                            style: GoogleFonts.ibmPlexMono(fontSize: 13.5),
                            decoration: const InputDecoration(
                              border: InputBorder.none,
                              contentPadding: EdgeInsets.all(18),
                            ),
                          ),
                        )
                      : const Center(child: Text('暂不支持二进制文件预览')),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: !file.editable || controller.savingFile
                      ? null
                      : () => controller.saveOpenedFile(editorController.text),
                  icon: const Icon(Icons.save_outlined),
                  label: Text(controller.savingFile ? '保存中…' : '保存文件'),
                ),
              ],
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
      return const _EmptyPane(
        title: '先选择会话再连接终端',
        body: '终端面板会跟随当前 session 自动切换。',
      );
    }
    return _SurfacePanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PaneHeader(
            title: 'Terminal',
            subtitle: '状态：${controller.terminalStatus}',
            trailing: Wrap(
              spacing: 8,
              children: [
                IconButton.filledTonal(
                  onPressed: controller.connectingTerminal
                      ? null
                      : controller.connectTerminal,
                  icon: const Icon(Icons.refresh),
                ),
                IconButton.outlined(
                  onPressed: controller.sendTerminalControlC,
                  icon: const Icon(Icons.cancel_presentation_outlined),
                ),
              ],
            ),
          ),
          if (controller.terminalError.isNotEmpty)
            _ErrorNotice(message: controller.terminalError),
          const SizedBox(height: 10),
          Expanded(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: const Color(0xFF11181C),
                borderRadius: BorderRadius.circular(26),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x22000000),
                    blurRadius: 28,
                    offset: Offset(0, 16),
                  ),
                ],
              ),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(26),
                  border: Border.all(
                    color: const Color(0xFF3B4C54).withValues(alpha: 0.55),
                  ),
                ),
                child: SingleChildScrollView(
                  child: SelectableText(
                    controller.terminalOutput.isEmpty
                        ? '终端输出会显示在这里。'
                        : controller.terminalOutput,
                    style: GoogleFonts.ibmPlexMono(
                      color: const Color(0xFFF3F5F7),
                      fontSize: 13,
                      height: 1.45,
                    ),
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
                    prefixIcon: Icon(Icons.keyboard_command_key_outlined),
                  ),
                  onSubmitted: (_) => _submit(),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: _submit,
                child: const Text('发送'),
              ),
            ],
          ),
        ],
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
  String _lastPath = '';

  @override
  void initState() {
    super.initState();
    _configController = TextEditingController();
  }

  @override
  void didUpdateWidget(covariant _ConfigPane oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextPath = widget.controller.configSnapshot?.path ?? '';
    if (_lastPath != nextPath) {
      _lastPath = nextPath;
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
    return _SurfacePanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PaneHeader(
            title: 'Config',
            subtitle:
                controller.configSnapshot?.path ?? '~/.manyoyo/manyoyo.json',
            trailing: IconButton.filledTonal(
              onPressed: controller.loadingConfig ? null : controller.loadConfig,
              icon: const Icon(Icons.refresh),
            ),
          ),
          if ((controller.configSnapshot?.notice ?? '').isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(controller.configSnapshot!.notice),
          ],
          if (controller.configError.isNotEmpty) ...[
            const SizedBox(height: 8),
            _ErrorNotice(message: controller.configError),
          ],
          const SizedBox(height: 10),
          Expanded(
            child: controller.loadingConfig && controller.configSnapshot == null
                ? const Center(child: CircularProgressIndicator())
                : DecoratedBox(
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceContainerLowest,
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(
                        color: Theme.of(context).colorScheme.outlineVariant,
                      ),
                    ),
                    child: TextField(
                      controller: _configController,
                      expands: true,
                      maxLines: null,
                      minLines: null,
                      style: GoogleFonts.ibmPlexMono(fontSize: 13.5),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.all(18),
                      ),
                    ),
                  ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: controller.savingConfig
                ? null
                : () => controller.saveConfig(_configController.text),
            icon: const Icon(Icons.save_outlined),
            label: Text(controller.savingConfig ? '保存中…' : '保存配置'),
          ),
        ],
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
        width: 620,
        child: SingleChildScrollView(
          child: Column(
            children: [
              DropdownButtonFormField<String>(
                initialValue: _run,
                decoration: const InputDecoration(labelText: 'run'),
                items: [
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
      decoration: InputDecoration(labelText: label),
    );
  }

  void _applyDefaults() {
    final defaults = Map<String, dynamic>.from(widget.seed.defaults);
    defaults.addAll(widget.seed.runs[_run] ?? const <String, dynamic>{});
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

class _PaneHeader extends StatelessWidget {
  const _PaneHeader({
    required this.title,
    required this.subtitle,
    this.trailing,
  });

  final String title;
  final String subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 12),
          Flexible(child: trailing!),
        ],
      ],
    );
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
        _MiniPill(label: detail!.status),
        if (detail!.agentProgram.isNotEmpty)
          _MiniPill(label: detail!.agentProgram),
        if (detail!.hostPath.isNotEmpty) _MiniPill(label: detail!.hostPath),
      ],
    );
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message});

  final MessageItem message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tone = switch (message.role) {
      'user' => theme.colorScheme.secondaryContainer,
      'assistant' => theme.colorScheme.primaryContainer,
      'system' => theme.colorScheme.surfaceContainerHighest,
      _ => theme.colorScheme.surfaceContainerLow,
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: tone,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.85),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _MiniPill(
                  label:
                      '${message.role.toUpperCase()}${message.pending ? ' · pending' : ''}',
                ),
                const Spacer(),
                if (message.timestamp.isNotEmpty)
                  Text(
                    message.timestamp,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
              ],
            ),
            const SizedBox(height: 10),
            SelectableText(
              message.content.isEmpty ? '…' : message.content,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
          ],
        ),
      ),
    );
  }
}

class _TracePanel extends StatelessWidget {
  const _TracePanel({required this.trace});

  final String trace;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xFFE4F0FF),
        borderRadius: BorderRadius.circular(22),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: SelectableText(
          trace,
          style: GoogleFonts.ibmPlexMono(
            fontSize: 12.5,
            height: 1.45,
            color: const Color(0xFF174A84),
          ),
        ),
      ),
    );
  }
}

class _FileTile extends StatelessWidget {
  const _FileTile({
    required this.icon,
    required this.name,
    required this.path,
    required this.onTap,
  });

  final IconData icon;
  final String name;
  final String path;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Ink(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
          child: Row(
            children: [
              Icon(icon),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name),
                    Text(
                      path,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.eyebrow,
    required this.value,
    required this.caption,
  });

  final String eyebrow;
  final String value;
  final String caption;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 180,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Colors.white.withValues(alpha: 0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            eyebrow,
            style: GoogleFonts.ibmPlexMono(
              fontSize: 11,
              color: Colors.white.withValues(alpha: 0.74),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: Theme.of(context).textTheme.headlineLarge?.copyWith(
              color: Colors.white,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            caption,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Colors.white.withValues(alpha: 0.76),
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'running' => const Color(0xFF0C8B54),
      'history' => const Color(0xFF9A6A2E),
      _ => Theme.of(context).colorScheme.outline,
    };
    return Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
        boxShadow: [
          BoxShadow(color: color.withValues(alpha: 0.42), blurRadius: 8),
        ],
      ),
    );
  }
}

class _MiniPill extends StatelessWidget {
  const _MiniPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: GoogleFonts.ibmPlexMono(
          fontSize: 11.5,
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({
    required this.label,
    required this.color,
    required this.foreground,
  });

  final String label;
  final Color color;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: GoogleFonts.ibmPlexMono(
          fontSize: 11,
          letterSpacing: 0.3,
          color: foreground,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _ErrorNotice extends StatelessWidget {
  const _ErrorNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Text(
        message,
        style: TextStyle(
          color: Theme.of(context).colorScheme.onErrorContainer,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _SurfacePanel extends StatelessWidget {
  const _SurfacePanel({
    required this.child,
    this.padding = const EdgeInsets.all(24),
    this.width,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double? width;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: width,
      padding: padding,
      decoration: BoxDecoration(
        color: theme.colorScheme.surface.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(30),
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.7),
        ),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.shadow.withValues(alpha: 0.12),
            blurRadius: 32,
            offset: const Offset(0, 18),
          ),
        ],
      ),
      child: child,
    );
  }
}

class _ShellBackdrop extends StatelessWidget {
  const _ShellBackdrop({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: dark
              ? const [
                  Color(0xFF101514),
                  Color(0xFF151F1C),
                  Color(0xFF1F2926),
                ]
              : const [
                  Color(0xFFE9E0CF),
                  Color(0xFFF4EEE3),
                  Color(0xFFE4D6BC),
                ],
        ),
      ),
      child: Stack(
        children: [
          Positioned(
            top: -70,
            left: -30,
            child: _BlurOrb(
              color: dark ? const Color(0xFF2A725B) : const Color(0xFFBFD7C6),
              size: 240,
            ),
          ),
          Positioned(
            right: -50,
            top: 140,
            child: _BlurOrb(
              color: dark ? const Color(0xFF8E5A2A) : const Color(0xFFE5C392),
              size: 200,
            ),
          ),
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(painter: _GridPainter(dark: dark)),
            ),
          ),
          Positioned.fill(
            child: Material(
              type: MaterialType.transparency,
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}

class _BlurOrb extends StatelessWidget {
  const _BlurOrb({required this.color, required this.size});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [
            color.withValues(alpha: 0.46),
            color.withValues(alpha: 0.0),
          ],
        ),
      ),
    );
  }
}

class _GridPainter extends CustomPainter {
  const _GridPainter({required this.dark});

  final bool dark;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = (dark ? Colors.white : Colors.black).withValues(alpha: 0.035)
      ..strokeWidth = 1;
    const gap = 36.0;
    for (double x = 0; x <= size.width; x += gap) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y <= size.height; y += gap) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _GridPainter oldDelegate) {
    return oldDelegate.dark != dark;
  }
}

class _EmptyPane extends StatelessWidget {
  const _EmptyPane({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return _SurfacePanel(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.dashboard_customize_outlined,
                size: 36,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(height: 16),
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              Text(
                body,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
