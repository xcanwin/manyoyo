import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

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
        return ShadApp.custom(
          themeMode: ThemeMode.dark,
          theme: _buildShadTheme(Brightness.light),
          darkTheme: _buildShadTheme(Brightness.dark),
          appBuilder: (BuildContext context) {
            return MaterialApp(
              title: 'MANYOYO Flutter',
              debugShowCheckedModeBanner: false,
              themeMode: ThemeMode.dark,
              theme: _buildMaterialTheme(Brightness.light),
              darkTheme: _buildMaterialTheme(Brightness.dark),
              localizationsDelegates: const [
                GlobalShadLocalizations.delegate,
              ],
              builder: (BuildContext context, Widget? child) {
                return ShadAppBuilder(child: child!);
              },
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
      },
    );
  }

  ShadThemeData _buildShadTheme(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    return ShadThemeData(
      brightness: brightness,
      colorScheme: isDark
          ? const ShadZincColorScheme.dark()
          : const ShadStoneColorScheme.light(),
      radius: BorderRadius.circular(18),
      disableSecondaryBorder: true,
      textTheme: ShadTextTheme.fromGoogleFont(GoogleFonts.ibmPlexSans),
    );
  }

  ThemeData _buildMaterialTheme(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF3B82F6),
      brightness: brightness,
    );
    final base = GoogleFonts.ibmPlexSansTextTheme(
      Typography.material2021(platform: TargetPlatform.macOS).black,
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor:
          isDark ? const Color(0xFF09090B) : const Color(0xFFF5F5F4),
      textTheme: base.copyWith(
        displaySmall: GoogleFonts.spaceGrotesk(
          fontSize: 36,
          fontWeight: FontWeight.w700,
          color: isDark ? const Color(0xFFFAFAFA) : const Color(0xFF111827),
        ),
        headlineSmall: GoogleFonts.spaceGrotesk(
          fontSize: 28,
          fontWeight: FontWeight.w700,
          color: isDark ? const Color(0xFFFAFAFA) : const Color(0xFF111827),
        ),
        titleLarge: base.titleLarge?.copyWith(
          fontWeight: FontWeight.w700,
          letterSpacing: -0.3,
        ),
        titleMedium: base.titleMedium?.copyWith(
          fontWeight: FontWeight.w700,
        ),
        bodyMedium: base.bodyMedium?.copyWith(height: 1.45),
        labelLarge: GoogleFonts.ibmPlexMono(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.15,
          color: isDark ? const Color(0xFFD4D4D8) : const Color(0xFF3F3F46),
        ),
      ),
    );
  }
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();

  @override
  Widget build(BuildContext context) {
    return _ConsoleBackdrop(
      child: Center(
        child: _WorkbenchPanel(
          width: 360,
          padding: const EdgeInsets.all(26),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(
                width: 36,
                height: 36,
                child: CircularProgressIndicator(strokeWidth: 3),
              ),
              const SizedBox(height: 16),
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
    return _ConsoleBackdrop(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1160),
            child: LayoutBuilder(
              builder: (BuildContext context, BoxConstraints constraints) {
                final stacked = constraints.maxWidth < 900;
                final hero = _LoginHero();
                final form = _LoginForm(
                  controller: controller,
                  baseUrlController: _baseUrlController,
                  usernameController: _usernameController,
                  passwordController: _passwordController,
                  onSubmit: _submit,
                );
                if (stacked) {
                  return Column(
                    children: [
                      hero,
                      const SizedBox(height: 18),
                      form,
                    ],
                  );
                }
                return Row(
                  children: [
                    Expanded(flex: 12, child: hero),
                    const SizedBox(width: 18),
                    Expanded(flex: 9, child: form),
                  ],
                );
              },
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
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _WorkbenchPanel(
      padding: const EdgeInsets.fromLTRB(28, 28, 28, 30),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: const [
              _TagChip(label: 'B / shadcn'),
              _TagChip(label: 'Desktop-first'),
              _TagChip(label: 'Pure Native'),
            ],
          ),
          const SizedBox(height: 28),
          Text(
            'MANYOYO 原生工作台',
            style: theme.textTheme.displaySmall,
          ),
          const SizedBox(height: 14),
          Text(
            '这条分支不是把 Material 默认控件换个配色，而是按 shadcn 的思路去做一套偏控制台、偏信息密度的桌面壳。',
            style: theme.textTheme.bodyLarge?.copyWith(
              color: const Color(0xFFA1A1AA),
            ),
          ),
          const SizedBox(height: 28),
          const _MetricStrip(),
          const SizedBox(height: 22),
          SizedBox(
            height: 360,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFF05060A),
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: const Color(0xFF27272A)),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x40000000),
                    blurRadius: 28,
                    offset: Offset(0, 16),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: const [
                      _WindowDot(color: Color(0xFFEF4444)),
                      SizedBox(width: 8),
                      _WindowDot(color: Color(0xFFF59E0B)),
                      SizedBox(width: 8),
                      _WindowDot(color: Color(0xFF22C55E)),
                    ],
                  ),
                  const SizedBox(height: 18),
                  Text(
                    '> manyoyo serve 0.0.0.0:3000',
                    style: GoogleFonts.ibmPlexMono(
                      color: const Color(0xFFFAFAFA),
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    '[gateway] auth enabled',
                    style: GoogleFonts.ibmPlexMono(
                      color: const Color(0xFF60A5FA),
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    '[flutter] native workspace attached',
                    style: GoogleFonts.ibmPlexMono(
                      color: const Color(0xFF34D399),
                      fontSize: 13,
                    ),
                  ),
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: const Color(0xFF1D4ED8)),
                      gradient: const LinearGradient(
                        colors: [Color(0x331D4ED8), Color(0x111D4ED8)],
                      ),
                    ),
                    child: const Row(
                      children: [
                        Icon(Icons.track_changes_outlined, size: 18),
                        SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            '目标是把当前 Web 控制台感迁移到 Flutter，而不是做成移动端练习册界面。',
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MetricStrip extends StatelessWidget {
  const _MetricStrip();

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 14,
      runSpacing: 14,
      children: const [
        _MetricCard(value: '100%', label: 'Flutter 原生'),
        _MetricCard(value: '0', label: 'Browser Shell'),
        _MetricCard(value: '4', label: '会话主面板'),
      ],
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 160),
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: const Color(0xFF111114),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0xFF27272A)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              value,
              style: GoogleFonts.spaceGrotesk(
                fontSize: 28,
                fontWeight: FontWeight.w700,
                color: const Color(0xFFFAFAFA),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              label,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: const Color(0xFFA1A1AA)),
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
    return _WorkbenchPanel(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const ShadBadge.secondary(child: Text('workspace login')),
          const SizedBox(height: 18),
          Text(
            '连接到 MANYOYO',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(
            '继续沿用服务端认证网关，Flutter 客户端只负责原生交互和工作台编排。',
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: const Color(0xFFA1A1AA)),
          ),
          const SizedBox(height: 22),
          _FieldLabel(label: '服务地址'),
          const SizedBox(height: 8),
          ShadInput(
            controller: baseUrlController,
            placeholder: const Text('http://127.0.0.1:3000'),
          ),
          const SizedBox(height: 14),
          _FieldLabel(label: '用户名'),
          const SizedBox(height: 8),
          ShadInput(
            controller: usernameController,
            placeholder: const Text('admin'),
          ),
          const SizedBox(height: 14),
          _FieldLabel(label: '密码'),
          const SizedBox(height: 8),
          ShadInput(
            controller: passwordController,
            obscureText: true,
            placeholder: const Text('输入认证密码'),
            onSubmitted: (_) => onSubmit(),
          ),
          const SizedBox(height: 16),
          if (controller.loginError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: _Banner(
                color: const Color(0xFF3F0D14),
                textColor: const Color(0xFFFDA4AF),
                text: controller.loginError,
              ),
            ),
          SizedBox(
            width: double.infinity,
            child: ShadButton(
              onPressed: controller.loggingIn ? null : onSubmit,
              leading: const Icon(Icons.login_rounded, size: 16),
              child: Text(controller.loggingIn ? '登录中…' : '登录 MANYOYO'),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: ShadButton.outline(
              onPressed: () {
                baseUrlController.text = 'http://127.0.0.1:3000';
              },
              child: const Text('填入本地默认地址'),
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
    return _ConsoleBackdrop(
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints constraints) {
              final wide = constraints.maxWidth >= 760;
              final sidebar = _SessionList(controller: controller);
              return Column(
                children: [
                  _TopBar(
                    controller: controller,
                    onCreate: _openCreateDialog,
                  ),
                  const SizedBox(height: 14),
                  if (controller.workspaceError.isNotEmpty)
                    _Banner(
                      color: const Color(0xFF172554),
                      textColor: const Color(0xFFBFDBFE),
                      text: controller.workspaceError,
                    ),
                  if (controller.workspaceError.isNotEmpty)
                    const SizedBox(height: 12),
                  Expanded(
                    child: wide
                        ? Row(
                            children: [
                              SizedBox(width: 320, child: sidebar),
                              const SizedBox(width: 14),
                              Expanded(
                                child: _WorkspacePane(controller: controller),
                              ),
                            ],
                          )
                        : Column(
                            children: [
                              SizedBox(height: 250, child: sidebar),
                              const SizedBox(height: 14),
                              Expanded(
                                child: _WorkspacePane(controller: controller),
                              ),
                            ],
                          ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
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

class _TopBar extends StatelessWidget {
  const _TopBar({required this.controller, required this.onCreate});

  final ManyoyoAppController controller;
  final Future<void> Function() onCreate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _WorkbenchPanel(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final compact = constraints.maxWidth < 920;
          final info = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 11,
                    height: 11,
                    decoration: const BoxDecoration(
                      color: Color(0xFF22C55E),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    controller.activeSessionName.isEmpty
                        ? 'MANYOYO Flutter'
                        : controller.activeSessionName,
                    style: theme.textTheme.titleLarge,
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                controller.session?.baseUrl ?? '',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: const Color(0xFFA1A1AA),
                ),
              ),
            ],
          );

          final actions = Wrap(
            spacing: 10,
            runSpacing: 10,
            alignment: WrapAlignment.end,
            children: [
              ShadButton.outline(
                onPressed: controller.loadingSessions
                    ? null
                    : controller.refreshSessions,
                leading: const Icon(Icons.refresh, size: 16),
                child: const Text('刷新'),
              ),
              ShadButton.outline(
                onPressed: controller.creatingSession ? null : onCreate,
                leading: const Icon(Icons.add, size: 16),
                child: const Text('新建会话'),
              ),
              ShadButton.destructive(
                onPressed: controller.logout,
                leading: const Icon(Icons.logout, size: 16),
                child: const Text('退出登录'),
              ),
            ],
          );

          final tabs = Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              _PaneButton(
                active: controller.pane == WorkspacePane.conversation,
                label: '会话',
                icon: Icons.chat_bubble_outline_rounded,
                onPressed: () => controller.setPane(WorkspacePane.conversation),
              ),
              _PaneButton(
                active: controller.pane == WorkspacePane.files,
                label: '文件',
                icon: Icons.folder_open_outlined,
                onPressed: () => controller.setPane(WorkspacePane.files),
              ),
              _PaneButton(
                active: controller.pane == WorkspacePane.terminal,
                label: '终端',
                icon: Icons.terminal_rounded,
                onPressed: () => controller.setPane(WorkspacePane.terminal),
              ),
              _PaneButton(
                active: controller.pane == WorkspacePane.config,
                label: '配置',
                icon: Icons.tune_rounded,
                onPressed: () => controller.setPane(WorkspacePane.config),
              ),
            ],
          );

          if (compact) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                info,
                const SizedBox(height: 14),
                actions,
                const SizedBox(height: 14),
                tabs,
              ],
            );
          }

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: info),
                  const SizedBox(width: 16),
                  Flexible(child: actions),
                ],
              ),
              const SizedBox(height: 14),
              tabs,
            ],
          );
        },
      ),
    );
  }
}

class _PaneButton extends StatelessWidget {
  const _PaneButton({
    required this.active,
    required this.label,
    required this.icon,
    required this.onPressed,
  });

  final bool active;
  final String label;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    if (active) {
      return ShadButton(
        onPressed: onPressed,
        leading: Icon(icon, size: 16),
        child: Text(label),
      );
    }
    return ShadButton.outline(
      onPressed: onPressed,
      leading: Icon(icon, size: 16),
      child: Text(label),
    );
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
    if (controller.loadingSessions && controller.sessions.isEmpty) {
      return const _CenterPanelLoader();
    }
    if (controller.sessions.isEmpty) {
      return const _EmptyPane(
        title: '当前没有可用会话',
        body: '新建一个会话，或者确认服务端已有历史会话。',
      );
    }
    return _WorkbenchPanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                'Sessions',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(width: 10),
              ShadBadge.outline(
                child: Text('${controller.sessions.length} active'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: ListView.separated(
              itemCount: controller.sessions.length,
              separatorBuilder: (_, _) => const SizedBox(height: 10),
              itemBuilder: (BuildContext context, int index) {
                final session = controller.sessions[index];
                final selected = session.name == controller.activeSessionName;
                return _SessionTile(
                  session: session,
                  selected: selected,
                  onTap: () => controller.selectSession(session.name),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.session,
    required this.selected,
    required this.onTap,
  });

  final SessionSummary session;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
              color: selected
                  ? const Color(0xFF2563EB)
                  : const Color(0xFF27272A),
            ),
            gradient: selected
                ? const LinearGradient(
                    colors: [Color(0x331D4ED8), Color(0x11181B1F)],
                  )
                : const LinearGradient(
                    colors: [Color(0xFF111114), Color(0xFF0C0C0E)],
                  ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    session.status == 'running'
                        ? Icons.play_circle_outline_rounded
                        : Icons.history_rounded,
                    size: 18,
                    color: selected
                        ? const Color(0xFF93C5FD)
                        : const Color(0xFFA1A1AA),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      session.name,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: const Color(0xFFFAFAFA),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                session.agentName,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: const Color(0xFFE4E4E7),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '${session.status} · ${session.messageCount} 条消息',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: const Color(0xFFA1A1AA),
                ),
              ),
            ],
          ),
        ),
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
      return const _EmptyPane(
        title: '先创建或选择一个会话',
        body: '左侧选择已有会话，或者直接从顶部新建一个工作区。',
      );
    }
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final compact = constraints.maxHeight < 380;
        final header = compact
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Conversation',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  _DetailHeader(detail: controller.activeSessionDetail),
                ],
              )
            : Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Conversation',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          '原生消息时间线与流式执行面板。',
                          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: const Color(0xFFA1A1AA),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 16),
                  Flexible(
                    child: _DetailHeader(detail: controller.activeSessionDetail),
                  ),
                ],
              );

        final messages = controller.loadingSessionContent
            ? const _CenterPanelLoader()
            : Container(
                decoration: BoxDecoration(
                  color: const Color(0xFF07080B),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFF27272A)),
                ),
                child: ListView.separated(
                  padding: const EdgeInsets.all(16),
                  itemCount: controller.messages.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 12),
                  itemBuilder: (BuildContext context, int index) {
                    final message = controller.messages[index];
                    return _MessageCard(message: message);
                  },
                ),
              );

        final prompt = compact
            ? ShadInput(
                controller: _promptController,
                placeholder: const Text('输入任务描述，客户端会直接走 /agent/stream。'),
              )
            : ShadTextarea(
                controller: _promptController,
                minHeight: 110,
                maxHeight: 180,
                placeholder: const Text('输入任务描述，客户端会直接走 /agent/stream。'),
              );

        final actions = Row(
          children: [
            Expanded(
              child: ShadButton(
                onPressed: controller.streamingAgent
                    ? null
                    : () async {
                        final prompt = _promptController.text;
                        _promptController.clear();
                        await controller.sendPrompt(prompt);
                      },
                leading: const Icon(Icons.send_rounded, size: 16),
                child: Text(controller.streamingAgent ? '运行中…' : '发送'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: ShadButton.outline(
                onPressed: controller.stoppingAgent || !controller.streamingAgent
                    ? null
                    : controller.stopAgent,
                leading: const Icon(Icons.stop_circle_outlined, size: 16),
                child: Text(controller.stoppingAgent ? '停止中…' : '停止'),
              ),
            ),
          ],
        );

        if (compact) {
          return _WorkbenchPanel(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                header,
                const SizedBox(height: 8),
                Expanded(child: messages),
                const SizedBox(height: 8),
                SizedBox(height: 44, child: prompt),
                const SizedBox(height: 8),
                actions,
              ],
            ),
          );
        }

        return _WorkbenchPanel(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              header,
              const SizedBox(height: 16),
              Expanded(child: messages),
              if (controller.liveTrace.isNotEmpty) ...[
                const SizedBox(height: 14),
                _Banner(
                  color: const Color(0xFF0F172A),
                  textColor: const Color(0xFF93C5FD),
                  text: controller.liveTrace,
                ),
              ],
              const SizedBox(height: 14),
              prompt,
              const SizedBox(height: 14),
              actions,
            ],
          ),
        );
      },
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
      return const _EmptyPane(
        title: '先选择会话再浏览文件',
        body: '文件面板会根据当前会话的 workspace 展示目录树。',
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
        if (wide) {
          return Row(
            children: [
              SizedBox(width: 320, child: browser),
              const SizedBox(width: 14),
              Expanded(child: editor),
            ],
          );
        }
        return Column(
          children: [
            SizedBox(height: 300, child: browser),
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
          backgroundColor: const Color(0xFF111114),
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
    return _WorkbenchPanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  controller.fileList?.path ?? '/',
                  style: Theme.of(context).textTheme.titleMedium,
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
          const SizedBox(height: 10),
          if (controller.fileError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _Banner(
                color: const Color(0xFF3F0D14),
                textColor: const Color(0xFFFDA4AF),
                text: controller.fileError,
              ),
            ),
          Expanded(
            child: controller.loadingFiles && controller.fileList == null
                ? const _CenterPanelLoader()
                : ListView.builder(
                    itemCount:
                        (controller.fileList?.entries.length ?? 0) +
                        ((controller.fileList?.parentPath ?? '').isEmpty ? 0 : 1),
                    itemBuilder: (BuildContext context, int index) {
                      final parentPath = controller.fileList?.parentPath ?? '';
                      if (parentPath.isNotEmpty && index == 0) {
                        return _FileRow(
                          icon: Icons.arrow_upward_rounded,
                          name: '..',
                          subtitle: parentPath,
                          onTap: () => controller.openDirectory(parentPath),
                        );
                      }
                      final offset = parentPath.isNotEmpty ? 1 : 0;
                      final entry = controller.fileList!.entries[index - offset];
                      final isDir = entry.kind == 'directory';
                      return _FileRow(
                        icon: isDir
                            ? Icons.folder_open_outlined
                            : Icons.description_outlined,
                        name: entry.name,
                        subtitle: entry.path,
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

class _FileRow extends StatelessWidget {
  const _FileRow({
    required this.icon,
    required this.name,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String name;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
          child: Row(
            children: [
              Icon(icon, size: 18, color: const Color(0xFFA1A1AA)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: const Color(0xFFA1A1AA),
                      ),
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
    if (file == null) {
      return const _EmptyPane(
        title: '从左侧选择一个文件',
        body: '文本文件会在这里直接编辑，二进制文件保持只读提示。',
      );
    }
    return _WorkbenchPanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  file.path,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              ShadBadge.secondary(
                child: Text(file.isText ? file.language : 'binary'),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            file.isText
                ? '语言：${file.language} · ${file.size} bytes'
                : '当前文件不是可编辑文本文件',
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: const Color(0xFFA1A1AA)),
          ),
          const SizedBox(height: 14),
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: const Color(0xFF05060A),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFF27272A)),
              ),
              child: file.isText
                  ? TextField(
                      controller: editorController,
                      expands: true,
                      maxLines: null,
                      minLines: null,
                      style: GoogleFonts.ibmPlexMono(
                        fontSize: 13.5,
                        height: 1.5,
                        color: const Color(0xFFE4E4E7),
                      ),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.all(16),
                      ),
                    )
                  : const Center(child: Text('暂不支持二进制文件预览')),
            ),
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: ShadButton(
              onPressed: !file.editable || controller.savingFile
                  ? null
                  : () => controller.saveOpenedFile(editorController.text),
              leading: const Icon(Icons.save_outlined, size: 16),
              child: Text(controller.savingFile ? '保存中…' : '保存文件'),
            ),
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
        body: '终端连接依赖当前活动会话的容器上下文。',
      );
    }
    return _WorkbenchPanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Terminal',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              ShadBadge.outline(child: Text(controller.terminalStatus)),
              const SizedBox(width: 10),
              ShadButton.outline(
                onPressed: controller.connectingTerminal
                    ? null
                    : controller.connectTerminal,
                leading: const Icon(Icons.refresh, size: 16),
                child: const Text('重连'),
              ),
              const SizedBox(width: 10),
              ShadButton.outline(
                onPressed: controller.sendTerminalControlC,
                leading: const Icon(Icons.cancel_presentation_outlined, size: 16),
                child: const Text('Ctrl+C'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (controller.terminalError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _Banner(
                color: const Color(0xFF3F0D14),
                textColor: const Color(0xFFFDA4AF),
                text: controller.terminalError,
              ),
            ),
          Expanded(
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFF020617),
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: const Color(0xFF1E293B)),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  controller.terminalOutput.isEmpty
                      ? '终端输出会显示在这里。'
                      : controller.terminalOutput,
                  style: GoogleFonts.ibmPlexMono(
                    color: const Color(0xFFE2E8F0),
                    fontSize: 13.5,
                    height: 1.45,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: ShadInput(
                  controller: _inputController,
                  placeholder: const Text('终端输入'),
                  onSubmitted: (_) => _submit(),
                ),
              ),
              const SizedBox(width: 12),
              ShadButton(
                onPressed: _submit,
                leading: const Icon(Icons.keyboard_return_rounded, size: 16),
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
    return _WorkbenchPanel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  controller.configSnapshot?.path ?? '~/.manyoyo/manyoyo.json',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              ShadButton.outline(
                onPressed: controller.loadingConfig ? null : controller.loadConfig,
                leading: const Icon(Icons.refresh, size: 16),
                child: const Text('刷新配置'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if ((controller.configSnapshot?.notice ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                controller.configSnapshot!.notice,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: const Color(0xFFA1A1AA),
                ),
              ),
            ),
          if (controller.configError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _Banner(
                color: const Color(0xFF3F0D14),
                textColor: const Color(0xFFFDA4AF),
                text: controller.configError,
              ),
            ),
          Expanded(
            child: controller.loadingConfig && controller.configSnapshot == null
                ? const _CenterPanelLoader()
                : Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFF05060A),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: const Color(0xFF27272A)),
                    ),
                    child: TextField(
                      controller: _configController,
                      expands: true,
                      maxLines: null,
                      minLines: null,
                      style: GoogleFonts.ibmPlexMono(
                        fontSize: 13.5,
                        height: 1.5,
                        color: const Color(0xFFE4E4E7),
                      ),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        contentPadding: EdgeInsets.all(16),
                      ),
                    ),
                  ),
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: ShadButton(
              onPressed: controller.savingConfig
                  ? null
                  : () => controller.saveConfig(_configController.text),
              leading: const Icon(Icons.save_outlined, size: 16),
              child: Text(controller.savingConfig ? '保存中…' : '保存配置'),
            ),
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
      backgroundColor: const Color(0xFF111114),
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
      alignment: WrapAlignment.end,
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
    return ShadBadge.outline(child: Text(label));
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message});

  final MessageItem message;

  @override
  Widget build(BuildContext context) {
    final borderColor = switch (message.role) {
      'user' => const Color(0xFF1D4ED8),
      'assistant' => const Color(0xFF059669),
      'system' => const Color(0xFFCA8A04),
      _ => const Color(0xFF3F3F46),
    };
    final background = switch (message.role) {
      'user' => const Color(0xFF0F172A),
      'assistant' => const Color(0xFF052E2B),
      'system' => const Color(0xFF3F2A06),
      _ => const Color(0xFF111114),
    };
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ShadBadge.outline(
            child: Text(
              '${message.role.toUpperCase()}${message.pending ? ' · pending' : ''}',
            ),
          ),
          if (message.timestamp.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              message.timestamp,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: const Color(0xFFA1A1AA),
              ),
            ),
          ],
          const SizedBox(height: 12),
          SelectableText(
            message.content.isEmpty ? '…' : message.content,
            style: Theme.of(context).textTheme.bodyLarge?.copyWith(
              color: const Color(0xFFE4E4E7),
            ),
          ),
        ],
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
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: textColor.withValues(alpha: 0.25)),
      ),
      child: SelectableText(
        text,
        style: TextStyle(
          color: textColor,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: Theme.of(context).textTheme.labelLarge,
    );
  }
}

class _TagChip extends StatelessWidget {
  const _TagChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return ShadBadge.outline(
      child: Text(
        label,
        style: GoogleFonts.ibmPlexMono(fontSize: 11.5),
      ),
    );
  }
}

class _WindowDot extends StatelessWidget {
  const _WindowDot({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

class _WorkbenchPanel extends StatelessWidget {
  const _WorkbenchPanel({
    required this.child,
    this.padding = const EdgeInsets.all(22),
    this.width,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double? width;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      padding: padding,
      decoration: BoxDecoration(
        color: const Color(0xCC0F1014),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: const Color(0xFF27272A)),
        boxShadow: const [
          BoxShadow(
            color: Color(0x66000000),
            blurRadius: 32,
            offset: Offset(0, 18),
          ),
        ],
      ),
      child: child,
    );
  }
}

class _ConsoleBackdrop extends StatelessWidget {
  const _ConsoleBackdrop({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Color(0xFF09090B),
            Color(0xFF0B1120),
            Color(0xFF09090B),
          ],
        ),
      ),
      child: Stack(
        children: [
          const Positioned(
            top: -120,
            left: -40,
            child: _BlurOrb(
              color: Color(0xFF1D4ED8),
              size: 280,
            ),
          ),
          const Positioned(
            right: -80,
            bottom: -40,
            child: _BlurOrb(
              color: Color(0xFF059669),
              size: 260,
            ),
          ),
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(painter: const _GridPainter()),
            ),
          ),
          Positioned.fill(child: child),
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
            color.withValues(alpha: 0.32),
            color.withValues(alpha: 0.0),
          ],
        ),
      ),
    );
  }
}

class _GridPainter extends CustomPainter {
  const _GridPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white.withValues(alpha: 0.04)
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
    return false;
  }
}

class _CenterPanelLoader extends StatelessWidget {
  const _CenterPanelLoader();

  @override
  Widget build(BuildContext context) {
    return const _WorkbenchPanel(
      child: Center(child: CircularProgressIndicator()),
    );
  }
}

class _EmptyPane extends StatelessWidget {
  const _EmptyPane({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return _WorkbenchPanel(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: const Color(0xFF111827),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: const Color(0xFF1D4ED8)),
                ),
                child: const Icon(Icons.dashboard_customize_outlined, size: 28),
              ),
              const SizedBox(height: 18),
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 10),
              Text(
                body,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                  color: const Color(0xFFA1A1AA),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
