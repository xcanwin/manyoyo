import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_controller.dart';
import 'models.dart';

const JsonEncoder _prettyJson = JsonEncoder.withIndent('  ');

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
          theme: _buildTheme(),
          builder: (BuildContext context, Widget? child) {
            return _AppBackground(child: child ?? const SizedBox.shrink());
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
  }
}

ThemeData _buildTheme() {
  final ThemeData base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: const ColorScheme.light(
      primary: _WebColors.accent,
      onPrimary: Colors.white,
      secondary: _WebColors.subaccent,
      onSecondary: Colors.white,
      error: _WebColors.danger,
      onError: Colors.white,
      surface: _WebColors.panelStrong,
      onSurface: _WebColors.text,
      outline: _WebColors.line,
      surfaceContainerHighest: _WebColors.panelSoft,
    ),
  );
  final TextTheme seededTextTheme = base.textTheme.apply(
    fontFamily: _WebFonts.ui,
    bodyColor: _WebColors.text,
    displayColor: _WebColors.text,
  );
  final TextTheme textTheme = seededTextTheme.copyWith(
    headlineSmall: _displayStyle(
      seededTextTheme.headlineSmall,
      fontWeight: FontWeight.w700,
      color: _WebColors.text,
      height: 1.05,
      letterSpacing: 0.4,
    ),
    titleLarge: _displayStyle(
      seededTextTheme.titleLarge,
      fontWeight: FontWeight.w700,
      color: _WebColors.text,
      height: 1.1,
      letterSpacing: 0.4,
    ),
    titleMedium: _uiStyle(
      seededTextTheme.titleMedium,
      fontWeight: FontWeight.w700,
      color: _WebColors.text,
    ),
    titleSmall: _uiStyle(
      seededTextTheme.titleSmall,
      fontWeight: FontWeight.w700,
      color: _WebColors.text,
    ),
    bodyLarge: _uiStyle(
      seededTextTheme.bodyLarge,
      color: _WebColors.text,
      height: 1.55,
    ),
    bodyMedium: _uiStyle(
      seededTextTheme.bodyMedium,
      color: _WebColors.text,
      height: 1.5,
    ),
    bodySmall: _uiStyle(
      seededTextTheme.bodySmall,
      color: _WebColors.muted,
      height: 1.45,
    ),
    labelLarge: _uiStyle(
      seededTextTheme.labelLarge,
      fontWeight: FontWeight.w700,
      letterSpacing: 0.15,
    ),
    labelMedium: _uiStyle(
      seededTextTheme.labelMedium,
      color: _WebColors.muted,
      fontWeight: FontWeight.w600,
    ),
    labelSmall: _uiStyle(
      seededTextTheme.labelSmall,
      color: _WebColors.muted,
      fontWeight: FontWeight.w600,
    ),
  );

  return base.copyWith(
    scaffoldBackgroundColor: Colors.transparent,
    textTheme: textTheme,
    splashFactory: InkRipple.splashFactory,
    dividerColor: _WebColors.line,
    dialogTheme: DialogThemeData(
      backgroundColor: _WebColors.panelStrong,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: _WebColors.line),
      ),
      titleTextStyle: textTheme.titleLarge,
      contentTextStyle: textTheme.bodyMedium,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      contentPadding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
      labelStyle: textTheme.bodySmall?.copyWith(
        color: _WebColors.muted,
        fontWeight: FontWeight.w700,
      ),
      hintStyle: textTheme.bodyMedium?.copyWith(
        color: _WebColors.muted.withValues(alpha: 0.74),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: _WebColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: _WebColors.accent),
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: _WebColors.line),
      ),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: const Color(0xFFFFFAF2),
      surfaceTintColor: Colors.transparent,
      textStyle: textTheme.bodyMedium,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: const BorderSide(color: _WebColors.line),
      ),
    ),
  );
}

class _WebColors {
  static const Color bgCanvas = Color(0xFFF3EDE4);
  static const Color bgCanvasAlt = Color(0xFFEFE4D3);
  static const Color bgGrid = Color(0x298A7253);
  static const Color panelSoft = Color(0xFFF9F2E7);
  static const Color panelStrong = Color(0xFFFFFFFF);
  static const Color line = Color(0xFFD9C7AD);
  static const Color text = Color(0xFF1F1A14);
  static const Color muted = Color(0xFF6A5F52);
  static const Color accent = Color(0xFFC4551F);
  static const Color accentStrong = Color(0xFF9D4418);
  static const Color subaccent = Color(0xFF0F7C72);
  static const Color subaccentStrong = Color(0xFF0A655E);
  static const Color danger = Color(0xFFBF332D);
  static const Color dangerStrong = Color(0xFF962824);
  static const Color dangerSoft = Color(0xFFFFE8E5);
  static const Color userBubble = Color(0xFFFEE9DD);
  static const Color assistantBubble = Color(0xFFFFFDF8);
  static const Color systemBubble = Color(0xFFE5F3F1);
  static const Color terminalBg = Color(0xFF11161D);
  static const Color terminalFg = Color(0xFFE8EDF5);
  static const Color statusRunningBg = Color(0xFFE0F5EF);
  static const Color statusRunningText = Color(0xFF0C695F);
  static const Color statusStoppedBg = Color(0xFFFFF0DD);
  static const Color statusStoppedText = Color(0xFF9A5A09);
  static const Color statusHistoryBg = Color(0xFFECE7DF);
  static const Color statusHistoryText = Color(0xFF645647);
  static const Color statusUnknownBg = Color(0xFFECE9FF);
  static const Color statusUnknownText = Color(0xFF5A4BB0);
}

class _WebFonts {
  static const String ui = 'IBM Plex Sans';
  static const String display = 'IBM Plex Sans Condensed';
  static const String mono = 'IBM Plex Mono';
}

TextStyle _uiStyle(
  TextStyle? base, {
  Color? color,
  FontWeight? fontWeight,
  double? fontSize,
  double? height,
  double? letterSpacing,
}) {
  return (base ?? const TextStyle()).copyWith(
    fontFamily: _WebFonts.ui,
    color: color,
    fontWeight: fontWeight,
    fontSize: fontSize,
    height: height,
    letterSpacing: letterSpacing,
  );
}

TextStyle _displayStyle(
  TextStyle? base, {
  Color? color,
  FontWeight? fontWeight,
  double? fontSize,
  double? height,
  double? letterSpacing,
}) {
  return (base ?? const TextStyle()).copyWith(
    fontFamily: _WebFonts.display,
    color: color,
    fontWeight: fontWeight,
    fontSize: fontSize,
    height: height,
    letterSpacing: letterSpacing,
  );
}

TextStyle _monoStyle(
  TextStyle? base, {
  Color? color,
  FontWeight? fontWeight,
  double? fontSize,
  double? height,
  double? letterSpacing,
}) {
  return (base ?? const TextStyle()).copyWith(
    fontFamily: _WebFonts.mono,
    color: color,
    fontWeight: fontWeight,
    fontSize: fontSize,
    height: height,
    letterSpacing: letterSpacing,
  );
}

class _AppBackground extends StatelessWidget {
  const _AppBackground({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[_WebColors.bgCanvas, _WebColors.bgCanvasAlt],
        ),
      ),
      child: Stack(
        children: <Widget>[
          const Positioned.fill(child: IgnorePointer(child: _BackdropLight())),
          const Positioned.fill(
            child: IgnorePointer(child: CustomPaint(painter: _GridPainter())),
          ),
          Positioned.fill(child: child),
        ],
      ),
    );
  }
}

class _BackdropLight extends StatelessWidget {
  const _BackdropLight();

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        Positioned(
          left: -180,
          top: -170,
          width: 540,
          height: 360,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                colors: <Color>[
                  const Color(0xFFF8F2EA),
                  const Color(0xFFF8F2EA).withValues(alpha: 0),
                ],
              ),
            ),
          ),
        ),
        Positioned(
          right: -120,
          bottom: -140,
          width: 460,
          height: 330,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                colors: <Color>[
                  const Color(0xFFF2DDC6),
                  const Color(0xFFF2DDC6).withValues(alpha: 0),
                ],
              ),
            ),
          ),
        ),
        Positioned.fill(
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: <Color>[
                  _WebColors.accent.withValues(alpha: 0.08),
                  Colors.transparent,
                  _WebColors.subaccent.withValues(alpha: 0.08),
                ],
                stops: const <double>[0, 0.42, 1],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _GridPainter extends CustomPainter {
  const _GridPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = _WebColors.bgGrid.withValues(alpha: 0.22)
      ..strokeWidth = 1;
    const double gap = 28;
    for (double x = gap; x < size.width; x += gap) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

enum _ButtonTone { primary, secondary, danger, dangerOutline }

ButtonStyle _buttonStyle(_ButtonTone tone) {
  final Color background = switch (tone) {
    _ButtonTone.primary => _WebColors.accent,
    _ButtonTone.secondary => _WebColors.panelSoft,
    _ButtonTone.danger => _WebColors.danger,
    _ButtonTone.dangerOutline => const Color(0xFFFFF5F3),
  };
  final Color foreground = switch (tone) {
    _ButtonTone.primary => Colors.white,
    _ButtonTone.secondary => _WebColors.text,
    _ButtonTone.danger => Colors.white,
    _ButtonTone.dangerOutline => _WebColors.danger,
  };
  final Color border = switch (tone) {
    _ButtonTone.primary => Colors.transparent,
    _ButtonTone.secondary => _WebColors.line,
    _ButtonTone.danger => Colors.transparent,
    _ButtonTone.dangerOutline => const Color(0xFFEDC1BC),
  };
  return ButtonStyle(
    minimumSize: const WidgetStatePropertyAll<Size>(Size(0, 40)),
    padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
      EdgeInsets.symmetric(horizontal: 14, vertical: 9),
    ),
    elevation: const WidgetStatePropertyAll<double>(0),
    backgroundColor: WidgetStateProperty.resolveWith<Color>((
      Set<WidgetState> states,
    ) {
      if (states.contains(WidgetState.disabled)) {
        return background.withValues(alpha: 0.58);
      }
      if (states.contains(WidgetState.hovered) ||
          states.contains(WidgetState.pressed)) {
        return switch (tone) {
          _ButtonTone.primary => _WebColors.accentStrong,
          _ButtonTone.secondary => const Color(0xFFF5EBDF),
          _ButtonTone.danger => _WebColors.dangerStrong,
          _ButtonTone.dangerOutline => _WebColors.dangerSoft,
        };
      }
      return background;
    }),
    foregroundColor: WidgetStatePropertyAll<Color>(foreground),
    shape: WidgetStatePropertyAll<OutlinedBorder>(
      RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(color: border),
      ),
    ),
    textStyle: const WidgetStatePropertyAll<TextStyle>(
      TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
    ),
  );
}

BoxDecoration _paneDecoration({bool dark = false}) {
  if (dark) {
    return BoxDecoration(
      color: const Color(0xFF131923),
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: _WebColors.line),
      boxShadow: const <BoxShadow>[
        BoxShadow(
          color: Color(0x1F2C1F0F),
          blurRadius: 34,
          offset: Offset(0, 14),
        ),
      ],
    );
  }
  return BoxDecoration(
    gradient: LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: <Color>[
        Colors.white.withValues(alpha: 0.88),
        const Color(0xFFFCF6EC).withValues(alpha: 0.88),
      ],
    ),
    borderRadius: BorderRadius.circular(14),
    border: Border.all(color: _WebColors.line),
  );
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Center(
        child: Container(
          width: 280,
          padding: const EdgeInsets.all(24),
          decoration: _paneDecoration(),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const SizedBox(
                width: 32,
                height: 32,
                child: CircularProgressIndicator(
                  strokeWidth: 2.6,
                  color: _WebColors.accent,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                '正在初始化 MANYOYO Flutter…',
                style: Theme.of(context).textTheme.titleMedium,
                textAlign: TextAlign.center,
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
  late final TextEditingController _usernameController;
  late final TextEditingController _passwordController;

  @override
  void initState() {
    super.initState();
    _usernameController = TextEditingController(
      text: widget.controller.draftUsername,
    );
    _passwordController = TextEditingController();
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    final TextTheme textTheme = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Container(
              padding: const EdgeInsets.fromLTRB(24, 26, 24, 20),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: <Color>[
                    Colors.white.withValues(alpha: 0.97),
                    const Color(0xFFF9F1E6).withValues(alpha: 0.97),
                  ],
                ),
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: _WebColors.line),
                boxShadow: const <BoxShadow>[
                  BoxShadow(
                    color: Color(0x332C1F0F),
                    blurRadius: 58,
                    offset: Offset(0, 24),
                  ),
                ],
              ),
              child: Stack(
                children: <Widget>[
                  Positioned(
                    left: 0,
                    right: 0,
                    top: -26,
                    child: Container(
                      height: 4,
                      decoration: const BoxDecoration(
                        borderRadius: BorderRadius.vertical(
                          top: Radius.circular(18),
                        ),
                        gradient: LinearGradient(
                          colors: <Color>[
                            _WebColors.accent,
                            _WebColors.subaccent,
                          ],
                        ),
                      ),
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 11,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFEE8DB),
                          borderRadius: BorderRadius.circular(99),
                        ),
                        child: Text(
                          'MANYOYO',
                          style: textTheme.labelSmall?.copyWith(
                            color: const Color(0xFF8B3713),
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.95,
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        'Web 登录',
                        style: _displayStyle(
                          textTheme.headlineSmall,
                          fontSize: 30,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        '登录后可访问容器会话与对话管理。',
                        style: textTheme.bodySmall?.copyWith(fontSize: 13),
                      ),
                      const SizedBox(height: 16),
                      _LabeledField(
                        label: '用户名',
                        child: TextField(controller: _usernameController),
                      ),
                      const SizedBox(height: 11),
                      _LabeledField(
                        label: '密码',
                        child: TextField(
                          controller: _passwordController,
                          obscureText: true,
                          onSubmitted: (_) => _submit(),
                        ),
                      ),
                      const SizedBox(height: 14),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton(
                          style: _buttonStyle(_ButtonTone.primary),
                          onPressed: controller.loggingIn ? null : _submit,
                          child: Text(controller.loggingIn ? '登录中…' : '登录'),
                        ),
                      ),
                      const SizedBox(height: 10),
                      SizedBox(
                        height: 20,
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            controller.loginError,
                            style: textTheme.bodySmall?.copyWith(
                              color: _WebColors.danger,
                              fontSize: 13,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _submit() {
    widget.controller.login(
      baseUrl: widget.controller.draftBaseUrl,
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
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final bool wide = constraints.maxWidth >= 980;
        final double drawerWidth = constraints.maxWidth * 0.86 < 346
            ? constraints.maxWidth * 0.86
            : 346;
        final Widget sidebar = _SidebarPanel(
          controller: controller,
          onOpenConfig: _openConfigDialog,
          onOpenCreate: _openCreateDialog,
          onCreateAgent: _createAgentForContainer,
          compact: !wide,
          onCloseSidebar: !wide
              ? () {
                  Navigator.of(context).maybePop();
                }
              : null,
          onSelectSession: !wide
              ? () {
                  Navigator.of(context).maybePop();
                }
              : null,
        );

        return Scaffold(
          key: _scaffoldKey,
          backgroundColor: Colors.transparent,
          drawerScrimColor: const Color(0x7A17110B),
          drawerEnableOpenDragGesture: !wide,
          drawer: wide
              ? null
              : Drawer(
                  width: drawerWidth,
                  elevation: 0,
                  backgroundColor: Colors.transparent,
                  child: SafeArea(child: sidebar),
                ),
          body: SafeArea(
            child: wide
                ? Row(
                    children: <Widget>[
                      SizedBox(width: 320, child: sidebar),
                      Expanded(
                        child: _MainPanel(
                          controller: controller,
                          onOpenSidebar: null,
                          onOpenCreate: _openCreateDialog,
                          onOpenConfig: _openConfigDialog,
                          onOpenAgentTemplate: _openAgentTemplateDialog,
                          onCreateAgent: _createAgentForActiveContainer,
                          onRemoveSession: _removeActiveContainer,
                          onRemoveSessionHistory: _removeActiveSessionHistory,
                        ),
                      ),
                    ],
                  )
                : _MainPanel(
                    controller: controller,
                    onOpenSidebar: () {
                      _scaffoldKey.currentState?.openDrawer();
                    },
                    onOpenCreate: _openCreateDialog,
                    onOpenConfig: _openConfigDialog,
                    onOpenAgentTemplate: _openAgentTemplateDialog,
                    onCreateAgent: _createAgentForActiveContainer,
                    onRemoveSession: _removeActiveContainer,
                    onRemoveSessionHistory: _removeActiveSessionHistory,
                  ),
          ),
        );
      },
    );
  }

  Future<void> _openCreateDialog() async {
    final ManyoyoAppController controller = widget.controller;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    try {
      final CreateSessionSeed seed = await controller.loadCreateSessionSeed();
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
      messenger.showSnackBar(SnackBar(content: Text('加载创建表单失败：$error')));
    }
  }

  Future<void> _openConfigDialog() async {
    final ManyoyoAppController controller = widget.controller;
    if (controller.configSnapshot == null && !controller.loadingConfig) {
      await controller.loadConfig();
    }
    if (!mounted) {
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (BuildContext context) {
        return _ConfigEditorDialog(controller: controller);
      },
    );
  }

  Future<void> _openAgentTemplateDialog() async {
    final ManyoyoAppController controller = widget.controller;
    if (controller.activeSessionName.isEmpty) {
      return;
    }
    if (controller.activeSessionDetail == null) {
      await controller.loadActiveSession();
    }
    if (!mounted || controller.activeSessionDetail == null) {
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (BuildContext context) {
        return _AgentTemplateDialog(controller: controller);
      },
    );
  }

  Future<void> _createAgentForContainer(String containerName) async {
    final ManyoyoAppController controller = widget.controller;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    await controller.createAgentSession(containerName);
    if (!mounted) {
      return;
    }
    if (controller.workspaceError.isNotEmpty) {
      messenger.showSnackBar(
        SnackBar(content: Text('新建 AGENT 失败：${controller.workspaceError}')),
      );
    }
  }

  Future<void> _createAgentForActiveContainer() async {
    final SessionSummary? activeSummary = widget.controller.sessions
        .cast<SessionSummary?>()
        .firstWhere(
          (SessionSummary? item) =>
              item != null &&
              item.name == widget.controller.activeSessionName,
          orElse: () => null,
        );
    final String containerName =
        widget.controller.activeSessionDetail?.containerName ??
        activeSummary?.containerName ??
        '';
    await _createAgentForContainer(containerName);
  }

  Future<void> _removeActiveContainer() async {
    final ManyoyoAppController controller = widget.controller;
    final SessionDetail? detail = controller.activeSessionDetail;
    if (controller.activeSessionName.isEmpty || detail == null) {
      return;
    }
    final bool confirmed = await _confirmDanger(
      title: '删除容器',
      message: '确认删除容器 ${detail.containerName} ?',
    );
    if (!confirmed) {
      return;
    }
    await controller.removeActiveSessionContainer();
  }

  Future<void> _removeActiveSessionHistory() async {
    final ManyoyoAppController controller = widget.controller;
    final SessionDetail? detail = controller.activeSessionDetail;
    if (controller.activeSessionName.isEmpty || detail == null) {
      return;
    }
    final bool confirmed = await _confirmDanger(
      title: '删除 AGENT',
      message: '确认删除 AGENT ${detail.agentName} ?',
    );
    if (!confirmed) {
      return;
    }
    await controller.removeActiveSessionWithHistory();
  }

  Future<bool> _confirmDanger({
    required String title,
    required String message,
  }) async {
    final bool? result = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: Text(title),
          content: Text(message),
          actions: <Widget>[
            FilledButton(
              style: _buttonStyle(_ButtonTone.secondary),
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              style: _buttonStyle(_ButtonTone.danger),
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('确认'),
            ),
          ],
        );
      },
    );
    return result ?? false;
  }
}

class _SidebarPanel extends StatefulWidget {
  const _SidebarPanel({
    required this.controller,
    required this.onOpenConfig,
    required this.onOpenCreate,
    required this.onCreateAgent,
    this.compact = false,
    this.onCloseSidebar,
    this.onSelectSession,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onOpenConfig;
  final Future<void> Function() onOpenCreate;
  final Future<void> Function(String containerName) onCreateAgent;
  final bool compact;
  final VoidCallback? onCloseSidebar;
  final VoidCallback? onSelectSession;

  @override
  State<_SidebarPanel> createState() => _SidebarPanelState();
}

class _SidebarPanelState extends State<_SidebarPanel> {
  final Map<String, bool> _expandedDirectories = <String, bool>{};
  final Map<String, bool> _expandedContainers = <String, bool>{};

  @override
  void initState() {
    super.initState();
    _primeExpansionState();
  }

  @override
  void didUpdateWidget(covariant _SidebarPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _primeExpansionState();
  }

  void _primeExpansionState() {
    final String activeSessionName = widget.controller.activeSessionName;
    if (activeSessionName.isEmpty) {
      return;
    }
    final List<_SidebarDirectoryGroup> groups = _groupSessionsByDirectory(
      widget.controller.sessions,
    );
    for (final _SidebarDirectoryGroup group in groups) {
      final bool groupHasActive = group.containers.any(
        (_SidebarContainerGroup container) => container.sessions.any(
          (SessionSummary session) => session.name == activeSessionName,
        ),
      );
      if (groupHasActive && !_expandedDirectories.containsKey(group.path)) {
        _expandedDirectories[group.path] = true;
      }
      for (final _SidebarContainerGroup container in group.containers) {
        final bool containerHasActive = container.sessions.any(
          (SessionSummary session) => session.name == activeSessionName,
        );
        final String key = _sidebarContainerKey(
          group.path,
          container.container,
        );
        if (containerHasActive && !_expandedContainers.containsKey(key)) {
          _expandedContainers[key] = true;
        }
      }
    }
  }

  bool _isDirectoryExpanded(_SidebarDirectoryGroup group) {
    return _expandedDirectories[group.path] ?? false;
  }

  bool _isContainerExpanded(_SidebarContainerGroup group) {
    return _expandedContainers[_sidebarContainerKey(
          group.path,
          group.container,
        )] ??
        false;
  }

  void _toggleDirectory(_SidebarDirectoryGroup group) {
    setState(() {
      _expandedDirectories[group.path] = !_isDirectoryExpanded(group);
    });
  }

  void _toggleContainer(_SidebarContainerGroup group) {
    setState(() {
      final String key = _sidebarContainerKey(group.path, group.container);
      _expandedContainers[key] = !_isContainerExpanded(group);
    });
  }

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    final List<_SidebarDirectoryGroup> groups = _groupSessionsByDirectory(
      controller.sessions,
    );
    final int directoryCount = groups.length;
    final int containerCount = controller.sessions
        .map((SessionSummary session) => session.containerName.trim())
        .where((String name) => name.isNotEmpty)
        .toSet()
        .length;
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFFFFFEFD), Color(0xFFF8F1E7)],
        ),
        border: Border(right: BorderSide(color: _WebColors.line)),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.only(bottom: 8),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Color(0x73B59263))),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            'MANYOYO Web',
                            style: _displayStyle(
                              Theme.of(context).textTheme.titleLarge,
                              fontSize: 22,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 1.1,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Container Session Console',
                            style: Theme.of(context).textTheme.labelSmall
                                ?.copyWith(fontSize: 11, letterSpacing: 0.3),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Flexible(
                      child: Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        alignment: WrapAlignment.end,
                        children: <Widget>[
                          FilledButton(
                            style: _buttonStyle(_ButtonTone.secondary),
                            onPressed: () async {
                              await widget.onOpenConfig();
                            },
                            child: const Text('配置'),
                          ),
                          FilledButton(
                            style: _buttonStyle(_ButtonTone.primary),
                            onPressed: () async {
                              await widget.onOpenCreate();
                            },
                            child: const Text('新建'),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (widget.compact &&
                    widget.onCloseSidebar != null) ...<Widget>[
                  const SizedBox(height: 8),
                  FilledButton(
                    style: _buttonStyle(_ButtonTone.secondary),
                    onPressed: widget.onCloseSidebar,
                    child: const Text('关闭'),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              Text(
                '工作台',
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: _WebColors.muted,
                  fontSize: 12,
                ),
              ),
              const Spacer(),
              Text(
                controller.loadingSessions
                    ? '加载中...'
                    : '$directoryCount 个 目录 / $containerCount 个容器 / ${controller.sessions.length} 个 AGENT',
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: _WebColors.muted,
                  fontSize: 12,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Expanded(
            child: controller.loadingSessions && controller.sessions.isEmpty
                ? const Center(
                    child: CircularProgressIndicator(
                      strokeWidth: 2.4,
                      color: _WebColors.accent,
                    ),
                  )
                : controller.sessions.isEmpty
                ? Center(
                    child: SizedBox(
                      width: double.infinity,
                      child: _EmptyNoteCard(message: '暂无 manyoyo 会话'),
                    ),
                  )
                : Scrollbar(
                    child: ListView.separated(
                      itemCount: groups.length,
                      padding: const EdgeInsets.only(right: 4),
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (BuildContext context, int index) {
                        final _SidebarDirectoryGroup group = groups[index];
                        return _SidebarDirectoryBlock(
                          group: group,
                          isLastSibling: index == groups.length - 1,
                          expanded: _isDirectoryExpanded(group),
                          activeSessionName: controller.activeSessionName,
                          onToggle: () {
                            _toggleDirectory(group);
                          },
                          onToggleContainer: _toggleContainer,
                          isContainerExpanded: _isContainerExpanded,
                          onSelectSession: (String sessionName) async {
                            await controller.selectSession(sessionName);
                            widget.onSelectSession?.call();
                          },
                          onCreateAgent: widget.onCreateAgent,
                        );
                      },
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _SidebarDirectoryBlock extends StatelessWidget {
  const _SidebarDirectoryBlock({
    required this.group,
    required this.isLastSibling,
    required this.expanded,
    required this.activeSessionName,
    required this.onToggle,
    required this.onToggleContainer,
    required this.isContainerExpanded,
    required this.onSelectSession,
    required this.onCreateAgent,
  });

  final _SidebarDirectoryGroup group;
  final bool isLastSibling;
  final bool expanded;
  final String activeSessionName;
  final VoidCallback onToggle;
  final void Function(_SidebarContainerGroup group) onToggleContainer;
  final bool Function(_SidebarContainerGroup group) isContainerExpanded;
  final Future<void> Function(String sessionName) onSelectSession;
  final Future<void> Function(String containerName) onCreateAgent;

  @override
  Widget build(BuildContext context) {
    final bool hasActive = group.containers.any(
      (_SidebarContainerGroup container) => container.sessions.any(
        (SessionSummary session) => session.name == activeSessionName,
      ),
    );
    final List<Widget> children = <Widget>[
      _SidebarTreeItem(
        ancestorHasNext: const <bool>[],
        isLastSibling: isLastSibling,
        kind: _SidebarTreeItemKind.directory,
        title: group.path,
        expandable: group.containers.isNotEmpty,
        expanded: expanded,
        emphasized: hasActive,
        onPressed: onToggle,
      ),
    ];
    if (expanded && group.containers.isNotEmpty) {
      children.add(const SizedBox(height: 8));
      children.add(
        Column(
          children: <Widget>[
            for (
              int index = 0;
              index < group.containers.length;
              index++
            ) ...<Widget>[
              _SidebarContainerBlock(
                group: group.containers[index],
                ancestorHasNext: <bool>[!isLastSibling],
                isLastSibling: index == group.containers.length - 1,
                expanded: isContainerExpanded(group.containers[index]),
                activeSessionName: activeSessionName,
                onToggle: () {
                  onToggleContainer(group.containers[index]);
                },
                onSelectSession: onSelectSession,
                onCreateAgent: onCreateAgent,
              ),
              if (index != group.containers.length - 1)
                const SizedBox(height: 8),
            ],
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }
}

class _SidebarContainerBlock extends StatelessWidget {
  const _SidebarContainerBlock({
    required this.group,
    required this.ancestorHasNext,
    required this.isLastSibling,
    required this.expanded,
    required this.activeSessionName,
    required this.onToggle,
    required this.onSelectSession,
    required this.onCreateAgent,
  });

  final _SidebarContainerGroup group;
  final List<bool> ancestorHasNext;
  final bool isLastSibling;
  final bool expanded;
  final String activeSessionName;
  final VoidCallback onToggle;
  final Future<void> Function(String sessionName) onSelectSession;
  final Future<void> Function(String containerName) onCreateAgent;

  @override
  Widget build(BuildContext context) {
    final _SidebarStatusInfo status = _sidebarStatusInfo(group.status);
    final bool hasActive = group.sessions.any(
      (SessionSummary session) => session.name == activeSessionName,
    );
    final List<Widget> children = <Widget>[
      _SidebarTreeItem(
        ancestorHasNext: ancestorHasNext,
        isLastSibling: isLastSibling,
        kind: _SidebarTreeItemKind.container,
        title: group.container.isEmpty ? '未命名容器' : group.container,
        meta: status.label,
        metaColor: status.color,
        expandable: group.sessions.isNotEmpty,
        expanded: expanded,
        emphasized: hasActive,
        historyTone: status.tone == 'history',
        trailing: Padding(
          padding: const EdgeInsets.only(left: 8),
          child: FilledButton(
            style: _buttonStyle(_ButtonTone.secondary),
            onPressed: () async {
              await onCreateAgent(group.container);
            },
            child: const Text('新建 AGENT'),
          ),
        ),
        onPressed: onToggle,
      ),
    ];
    if (expanded && group.sessions.isNotEmpty) {
      children.add(const SizedBox(height: 8));
      children.add(
        Column(
          children: <Widget>[
            for (
              int index = 0;
              index < group.sessions.length;
              index++
            ) ...<Widget>[
              _SidebarTreeItem(
                ancestorHasNext: ancestorHasNext.followedBy(<bool>[
                  !isLastSibling,
                ]).toList(),
                isLastSibling: index == group.sessions.length - 1,
                kind: _SidebarTreeItemKind.agent,
                title: group.sessions[index].agentName,
                meta: _formatSidebarDateTime(group.sessions[index].updatedAt),
                active: group.sessions[index].name == activeSessionName,
                historyTone: status.tone == 'history',
                onPressed: () async {
                  await onSelectSession(group.sessions[index].name);
                },
              ),
              if (index != group.sessions.length - 1) const SizedBox(height: 8),
            ],
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }
}

enum _SidebarTreeItemKind { directory, container, agent }

class _SidebarTreeItem extends StatefulWidget {
  const _SidebarTreeItem({
    required this.ancestorHasNext,
    required this.isLastSibling,
    required this.kind,
    required this.title,
    required this.onPressed,
    this.trailing,
    this.meta,
    this.metaColor,
    this.expandable = false,
    this.expanded = false,
    this.active = false,
    this.emphasized = false,
    this.historyTone = false,
  });

  final List<bool> ancestorHasNext;
  final bool isLastSibling;
  final _SidebarTreeItemKind kind;
  final String title;
  final Widget? trailing;
  final String? meta;
  final Color? metaColor;
  final VoidCallback onPressed;
  final bool expandable;
  final bool expanded;
  final bool active;
  final bool emphasized;
  final bool historyTone;

  @override
  State<_SidebarTreeItem> createState() => _SidebarTreeItemState();
}

class _SidebarTreeItemState extends State<_SidebarTreeItem> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final bool useTreeGradient =
        widget.kind == _SidebarTreeItemKind.directory ||
        widget.kind == _SidebarTreeItemKind.container;
    final Color borderColor = widget.active
        ? const Color(0xFFC68D5A)
        : _hovering
        ? const Color(0xFFD1AA7F)
        : widget.emphasized
        ? const Color(0xFFC68D5A)
        : const Color(0x61B59263);
    final List<BoxShadow>? boxShadow = widget.active
        ? const <BoxShadow>[
            BoxShadow(color: Color(0x24C4551F), blurRadius: 0, spreadRadius: 2),
          ]
        : widget.emphasized
        ? const <BoxShadow>[
            BoxShadow(color: Color(0x14C4551F), blurRadius: 0, spreadRadius: 2),
          ]
        : null;
    final Color backgroundColor = widget.active
        ? const Color(0xFFFFF3E8)
        : _hovering
        ? const Color(0xFFFFF8EF)
        : const Color(0xF0FFFFFF);
    final Gradient? backgroundGradient =
        widget.active || _hovering || !useTreeGradient
        ? null
        : const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[Color(0xF5FFFFFF), Color(0xFAF9F2E8)],
          );
    final Color titleColor = widget.historyTone
        ? _WebColors.statusHistoryText
        : _WebColors.text;
    final Color metaColor =
        widget.metaColor ??
        (widget.historyTone
            ? _WebColors.statusHistoryText
            : const Color(0xFF7B6D5D));
    return MouseRegion(
      onEnter: (_) {
        setState(() {
          _hovering = true;
        });
      },
      onExit: (_) {
        setState(() {
          _hovering = false;
        });
      },
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _SidebarTreePrefix(
            ancestorHasNext: widget.ancestorHasNext,
            isLastSibling: widget.isLastSibling,
            expandable: widget.expandable,
            expanded: widget.expanded,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: widget.onPressed,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 140),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 11,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: backgroundGradient == null ? backgroundColor : null,
                    gradient: backgroundGradient,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: borderColor),
                    boxShadow: boxShadow,
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      if (widget.active) ...<Widget>[
                        Container(
                          width: 3,
                          height: 30,
                          decoration: BoxDecoration(
                            color: _WebColors.accent,
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        const SizedBox(width: 8),
                      ],
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              widget.title,
                              style:
                                  (widget.kind == _SidebarTreeItemKind.agent
                                          ? Theme.of(
                                              context,
                                            ).textTheme.titleSmall
                                          : _monoStyle(
                                              Theme.of(
                                                context,
                                              ).textTheme.titleSmall,
                                            ))
                                      ?.copyWith(
                                        color: titleColor,
                                        fontSize:
                                            widget.kind ==
                                                _SidebarTreeItemKind.agent
                                            ? 13
                                            : 12,
                                        fontWeight:
                                            widget.kind ==
                                                _SidebarTreeItemKind.agent
                                            ? FontWeight.w700
                                            : FontWeight.w600,
                                        height: 1.5,
                                      ),
                              overflow: TextOverflow.ellipsis,
                            ),
                            if ((widget.meta ?? '')
                                .trim()
                                .isNotEmpty) ...<Widget>[
                              const SizedBox(height: 6),
                              Text(
                                widget.meta!,
                                style: Theme.of(context).textTheme.labelSmall
                                    ?.copyWith(
                                      color: metaColor,
                                      fontSize:
                                          widget.kind ==
                                              _SidebarTreeItemKind.container
                                          ? 12
                                          : 11,
                                      fontWeight:
                                          widget.kind ==
                                              _SidebarTreeItemKind.container
                                          ? FontWeight.w700
                                          : FontWeight.w500,
                                      height: 1.45,
                                    ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (widget.trailing != null) widget.trailing!,
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SidebarTreePrefix extends StatelessWidget {
  const _SidebarTreePrefix({
    required this.ancestorHasNext,
    required this.isLastSibling,
    required this.expandable,
    required this.expanded,
  });

  final List<bool> ancestorHasNext;
  final bool isLastSibling;
  final bool expandable;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 38,
      child: Row(
        children: <Widget>[
          for (final bool _ in ancestorHasNext)
            const SizedBox(width: 10, height: 38),
          SizedBox(
            width: 10,
            height: 38,
            child: CustomPaint(
              painter: _SidebarBranchPainter(isLastSibling: isLastSibling),
            ),
          ),
          if (expandable)
            SizedBox(
              width: 16,
              height: 38,
              child: Center(
                child: AnimatedRotation(
                  duration: const Duration(milliseconds: 140),
                  turns: expanded ? 0.25 : 0,
                  child: const Icon(
                    Icons.chevron_right_rounded,
                    size: 14,
                    color: Color(0xFF8C7257),
                  ),
                ),
              ),
            )
          else
            const SizedBox(
              width: 12,
              height: 38,
              child: Center(
                child: SizedBox(
                  width: 10,
                  child: Divider(
                    height: 1,
                    thickness: 1,
                    color: Color(0xFFD9C7AD),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _SidebarBranchPainter extends CustomPainter {
  const _SidebarBranchPainter({required this.isLastSibling});

  final bool isLastSibling;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint verticalPaint = Paint()
      ..color = const Color(0xFFCCB79E)
      ..strokeWidth = 1;
    final Paint horizontalPaint = Paint()
      ..color = const Color(0xFFD9C7AD)
      ..strokeWidth = 1;
    final double x = 5;
    final double midY = size.height / 2;
    canvas.drawLine(
      Offset(x, -6),
      Offset(x, isLastSibling ? midY : size.height + 6),
      verticalPaint,
    );
    canvas.drawLine(Offset(x, midY), Offset(size.width, midY), horizontalPaint);
  }

  @override
  bool shouldRepaint(covariant _SidebarBranchPainter oldDelegate) {
    return oldDelegate.isLastSibling != isLastSibling;
  }
}

class _MainPanel extends StatelessWidget {
  const _MainPanel({
    required this.controller,
    required this.onOpenCreate,
    required this.onOpenConfig,
    required this.onOpenAgentTemplate,
    required this.onCreateAgent,
    required this.onRemoveSession,
    required this.onRemoveSessionHistory,
    this.onOpenSidebar,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onOpenCreate;
  final Future<void> Function() onOpenConfig;
  final Future<void> Function() onOpenAgentTemplate;
  final Future<void> Function() onCreateAgent;
  final Future<void> Function() onRemoveSession;
  final Future<void> Function() onRemoveSessionHistory;
  final VoidCallback? onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xFFFDFBF3), Color(0xFFF7EDDF)],
        ),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _WorkspaceHeader(
            controller: controller,
            onOpenSidebar: onOpenSidebar,
            onOpenCreate: onOpenCreate,
            onCreateAgent: onCreateAgent,
            onRemoveSession: onRemoveSession,
            onRemoveSessionHistory: onRemoveSessionHistory,
          ),
          if (controller.workspaceError.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            _Banner(
              backgroundColor: _WebColors.dangerSoft,
              borderColor: const Color(0xFFEDC1BC),
              textColor: _WebColors.danger,
              text: controller.workspaceError,
            ),
          ],
          const SizedBox(height: 10),
          Expanded(
            child: _WorkspacePane(
              controller: controller,
              onOpenAgentTemplate: onOpenAgentTemplate,
            ),
          ),
        ],
      ),
    );
  }
}

class _WorkspaceHeader extends StatelessWidget {
  const _WorkspaceHeader({
    required this.controller,
    required this.onOpenCreate,
    required this.onCreateAgent,
    required this.onRemoveSession,
    required this.onRemoveSessionHistory,
    this.onOpenSidebar,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onOpenCreate;
  final Future<void> Function() onCreateAgent;
  final Future<void> Function() onRemoveSession;
  final Future<void> Function() onRemoveSessionHistory;
  final VoidCallback? onOpenSidebar;

  @override
  Widget build(BuildContext context) {
    final SessionDetail? detail = controller.activeSessionDetail;
    final String meta = detail == null
        ? '请选择左侧会话'
        : '${detail.agentName} · ${detail.status} · ${detail.messageCount} 条消息';
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 12),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0x7AB59263))),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              if (onOpenSidebar != null) ...<Widget>[
                FilledButton(
                  style: _buttonStyle(_ButtonTone.secondary),
                  onPressed: onOpenSidebar,
                  child: const Text('会话'),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: Text(
                  controller.activeSessionName.isEmpty
                      ? '未选择会话'
                      : controller.activeSessionName,
                  style: _displayStyle(
                    Theme.of(context).textTheme.titleLarge,
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              _HeaderActions(
                controller: controller,
                onOpenCreate: onOpenCreate,
                onCreateAgent: onCreateAgent,
                onRemoveSession: onRemoveSession,
                onRemoveSessionHistory: onRemoveSessionHistory,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            meta,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(fontSize: 12),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: _workspaceTabs.map(((_WorkspaceTab tab) {
              final bool active = controller.pane == tab.pane;
              return FilledButton(
                style: _buttonStyle(
                  active ? _ButtonTone.primary : _ButtonTone.secondary,
                ),
                onPressed: () async {
                  await controller.setPane(tab.pane);
                },
                child: Text(tab.label),
              );
            })).toList(),
          ),
        ],
      ),
    );
  }
}

class _HeaderActions extends StatelessWidget {
  const _HeaderActions({
    required this.controller,
    required this.onOpenCreate,
    required this.onCreateAgent,
    required this.onRemoveSession,
    required this.onRemoveSessionHistory,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onOpenCreate;
  final Future<void> Function() onCreateAgent;
  final Future<void> Function() onRemoveSession;
  final Future<void> Function() onRemoveSessionHistory;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<_HeaderAction>(
      tooltip: '更多',
      color: const Color(0xFFFFFAF2),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: const BorderSide(color: _WebColors.line),
      ),
      onSelected: (_HeaderAction action) async {
        switch (action) {
          case _HeaderAction.refresh:
            await controller.refreshSessions();
            break;
          case _HeaderAction.create:
            await onOpenCreate();
            break;
          case _HeaderAction.removeSession:
            await onRemoveSession();
            break;
          case _HeaderAction.createAgent:
            await onCreateAgent();
            break;
          case _HeaderAction.removeSessionHistory:
            await onRemoveSessionHistory();
            break;
        }
      },
      itemBuilder: (BuildContext context) {
        final bool busy =
            controller.creatingAgent ||
            controller.creatingSession ||
            controller.removingSession ||
            controller.removingSessionHistory;
        return <PopupMenuEntry<_HeaderAction>>[
          PopupMenuItem<_HeaderAction>(
            value: _HeaderAction.refresh,
            child: Text('刷新'),
          ),
          PopupMenuItem<_HeaderAction>(
            value: _HeaderAction.create,
            child: Text('新建容器'),
          ),
          PopupMenuItem<_HeaderAction>(
            enabled: controller.activeSessionName.isNotEmpty && !busy,
            value: _HeaderAction.removeSession,
            child: const Text('删除容器'),
          ),
          PopupMenuItem<_HeaderAction>(
            enabled: controller.activeSessionName.isNotEmpty && !busy,
            value: _HeaderAction.createAgent,
            child: const Text('新建 AGENT'),
          ),
          PopupMenuItem<_HeaderAction>(
            enabled: controller.activeSessionName.isNotEmpty && !busy,
            value: _HeaderAction.removeSessionHistory,
            child: const Text('删除 AGENT'),
          ),
        ];
      },
      child: IgnorePointer(
        child: FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: () {},
          child: const Text('更多'),
        ),
      ),
    );
  }
}

enum _HeaderAction {
  refresh,
  create,
  removeSession,
  createAgent,
  removeSessionHistory,
}

class _WorkspaceTab {
  const _WorkspaceTab(this.pane, this.label);

  final WorkspacePane pane;
  final String label;
}

const List<_WorkspaceTab> _workspaceTabs = <_WorkspaceTab>[
  _WorkspaceTab(WorkspacePane.conversation, '活动'),
  _WorkspaceTab(WorkspacePane.terminal, '终端'),
  _WorkspaceTab(WorkspacePane.files, '文件'),
  _WorkspaceTab(WorkspacePane.detail, '详情'),
  _WorkspaceTab(WorkspacePane.config, '配置'),
  _WorkspaceTab(WorkspacePane.check, '检查'),
];

class _WorkspacePane extends StatelessWidget {
  const _WorkspacePane({
    required this.controller,
    required this.onOpenAgentTemplate,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onOpenAgentTemplate;

  @override
  Widget build(BuildContext context) {
    return switch (controller.pane) {
      WorkspacePane.conversation => _ConversationPane(
        controller: controller,
        onOpenAgentTemplate: onOpenAgentTemplate,
      ),
      WorkspacePane.terminal => _TerminalPane(controller: controller),
      WorkspacePane.files => _FilesPane(controller: controller),
      WorkspacePane.detail => _DetailPane(controller: controller),
      WorkspacePane.config => _ConfigPane(controller: controller),
      WorkspacePane.check => _CheckPane(controller: controller),
    };
  }
}

enum _ComposerMode { agent, command }

extension on _ComposerMode {
  String get label => this == _ComposerMode.agent ? 'agent' : 'command';
}

class _ConversationPane extends StatefulWidget {
  const _ConversationPane({
    required this.controller,
    required this.onOpenAgentTemplate,
  });

  final ManyoyoAppController controller;
  final Future<void> Function() onOpenAgentTemplate;

  @override
  State<_ConversationPane> createState() => _ConversationPaneState();
}

class _ConversationPaneState extends State<_ConversationPane> {
  late final TextEditingController _promptController;
  _ComposerMode _mode = _ComposerMode.agent;

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
    final ManyoyoAppController controller = widget.controller;
    final String agentProgram =
        controller.activeSessionDetail?.agentProgram.trim().isNotEmpty == true
        ? controller.activeSessionDetail!.agentProgram
        : '—';
    if (controller.activeSessionName.isEmpty) {
      return const _EmptyPane(message: '先创建或选择一个会话');
    }
    return Container(
      decoration: _paneDecoration(),
      child: Column(
        children: <Widget>[
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                children: <Widget>[
                  _ConversationSummary(detail: controller.activeSessionDetail),
                  const SizedBox(height: 12),
                  Expanded(
                    child: controller.loadingSessionContent
                        ? const Center(
                            child: CircularProgressIndicator(
                              strokeWidth: 2.4,
                              color: _WebColors.accent,
                            ),
                          )
                        : controller.messages.isEmpty
                        ? const _EmptyPanelBody(message: '当前还没有消息，输入任务后即可开始。')
                        : Scrollbar(
                            child: ListView.separated(
                              itemCount: controller.messages.length,
                              separatorBuilder: (_, _) =>
                                  const SizedBox(height: 14),
                              itemBuilder: (BuildContext context, int index) {
                                final MessageItem message =
                                    controller.messages[index];
                                return _MessageBubble(
                                  message: message,
                                  activeMode: _mode.label,
                                );
                              },
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
          if (controller.liveTrace.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
              child: _Banner(
                backgroundColor: const Color(0xFFEAF3FF),
                borderColor: const Color(0xFFBBD4FF),
                textColor: const Color(0xFF175CD3),
                text: controller.liveTrace,
              ),
            ),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(8, 12, 8, 4),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: const Color(0x73B59263))),
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[
                  Colors.white.withValues(alpha: 0.32),
                  const Color(0xFFFFF9F0).withValues(alpha: 0.78),
                ],
              ),
            ),
            child: Column(
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        FilledButton(
                          style: _buttonStyle(
                            _mode == _ComposerMode.agent
                                ? _ButtonTone.primary
                                : _ButtonTone.secondary,
                          ),
                          onPressed: () {
                            setState(() {
                              _mode = _ComposerMode.agent;
                            });
                          },
                          child: const Text('Agent'),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          style: _buttonStyle(
                            _mode == _ComposerMode.command
                                ? _ButtonTone.primary
                                : _ButtonTone.secondary,
                          ),
                          onPressed: () {
                            setState(() {
                              _mode = _ComposerMode.command;
                            });
                          },
                          child: const Text('命令'),
                        ),
                      ],
                    ),
                    const Spacer(),
                    Wrap(
                      spacing: 10,
                      runSpacing: 8,
                      children: <Widget>[
                        _ToolbarButtonChip(
                          label:
                              'CLI · ${_summarizeCli(detail: controller.activeSessionDetail)}',
                          onPressed: controller.activeSessionName.isEmpty
                              ? null
                              : widget.onOpenAgentTemplate,
                        ),
                        _ToolbarChip(label: '模型 · $agentProgram'),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: <Widget>[
                    Expanded(
                      child: TextField(
                        controller: _promptController,
                        minLines: 4,
                        maxLines: 8,
                        style: _monoStyle(
                          Theme.of(context).textTheme.bodyMedium,
                          fontSize: 13,
                          height: 1.5,
                        ),
                        decoration: InputDecoration(
                          hintText: _mode == _ComposerMode.agent
                              ? '输入任务描述，直接走 /agent/stream'
                              : '输入容器命令，例如: ls -la',
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Column(
                      children: <Widget>[
                        FilledButton(
                          style: _buttonStyle(_ButtonTone.primary),
                          onPressed:
                              controller.streamingAgent ||
                                  controller.runningCommand
                              ? null
                              : _submit,
                          child: Text(
                            controller.streamingAgent
                                ? '运行中…'
                                : controller.runningCommand
                                ? '执行中…'
                                : '发送',
                          ),
                        ),
                        const SizedBox(height: 8),
                        FilledButton(
                          style: _buttonStyle(_ButtonTone.dangerOutline),
                          onPressed:
                              controller.stoppingAgent ||
                                  !controller.streamingAgent
                              ? null
                              : controller.stopAgent,
                          child: Text(controller.stoppingAgent ? '停止中…' : '停止'),
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    Text(
                      'Enter 发送 · Shift/Alt + Enter 换行',
                      style: Theme.of(
                        context,
                      ).textTheme.labelMedium?.copyWith(fontSize: 12),
                    ),
                    const Spacer(),
                    Text(
                      controller.activeSessionName.isEmpty
                          ? '未选择会话'
                          : controller.streamingAgent
                          ? '发送中'
                          : controller.runningCommand
                          ? '执行中'
                          : _mode == _ComposerMode.command
                          ? '命令模式已接入'
                          : '已就绪',
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontSize: 12,
                        color: controller.streamingAgent
                            ? _WebColors.accent
                            : _WebColors.muted,
                        fontWeight: controller.streamingAgent
                            ? FontWeight.w700
                            : FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _submit() async {
    final String prompt = _promptController.text;
    if (prompt.trim().isEmpty) {
      return;
    }
    _promptController.clear();
    if (_mode == _ComposerMode.command) {
      await widget.controller.runCommand(prompt);
      return;
    }
    await widget.controller.sendPrompt(prompt);
  }
}

class _ConversationSummary extends StatelessWidget {
  const _ConversationSummary({required this.detail});

  final SessionDetail? detail;

  @override
  Widget build(BuildContext context) {
    if (detail == null) {
      return const SizedBox.shrink();
    }
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: <Widget>[
        _InfoChip(label: detail!.status, tone: _statusTheme(detail!.status)),
        if (detail!.agentProgram.isNotEmpty)
          _InfoChip(
            label: detail!.agentProgram,
            backgroundColor: _WebColors.panelSoft,
            foregroundColor: _WebColors.text,
            borderColor: _WebColors.line,
          ),
        if (detail!.hostPath.isNotEmpty)
          _InfoChip(
            label: detail!.hostPath,
            backgroundColor: Colors.white,
            foregroundColor: _WebColors.text,
            borderColor: _WebColors.line,
            monospace: true,
          ),
        if (detail!.containerPath.isNotEmpty)
          _InfoChip(
            label: detail!.containerPath,
            backgroundColor: Colors.white,
            foregroundColor: _WebColors.text,
            borderColor: _WebColors.line,
            monospace: true,
          ),
      ],
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
    final String currentPath = widget.controller.fileRead?.path ?? '';
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
    final ManyoyoAppController controller = widget.controller;
    if (controller.activeSessionName.isEmpty) {
      return const _EmptyPane(message: '先选择会话再浏览文件');
    }
    return Container(
      decoration: _paneDecoration(),
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final bool wide = constraints.maxWidth >= 900;
          final Widget browser = _FileBrowser(
            controller: controller,
            onCreateDir: _createDir,
          );
          final Widget editor = _FileEditor(
            controller: controller,
            editorController: _editorController,
          );
          return wide
              ? Row(
                  children: <Widget>[
                    SizedBox(width: 300, child: browser),
                    Container(width: 1, color: _WebColors.line),
                    Expanded(child: editor),
                  ],
                )
              : Column(
                  children: <Widget>[
                    SizedBox(height: 280, child: browser),
                    Container(height: 1, color: _WebColors.line),
                    Expanded(child: editor),
                  ],
                );
        },
      ),
    );
  }

  Future<void> _createDir() async {
    final ManyoyoAppController controller = widget.controller;
    final TextEditingController nameController = TextEditingController();
    final String? result = await showDialog<String>(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: const Text('创建目录'),
          content: TextField(
            controller: nameController,
            decoration: const InputDecoration(labelText: '目录名'),
          ),
          actions: <Widget>[
            FilledButton(
              style: _buttonStyle(_ButtonTone.secondary),
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              style: _buttonStyle(_ButtonTone.primary),
              onPressed: () =>
                  Navigator.of(context).pop(nameController.text.trim()),
              child: const Text('创建'),
            ),
          ],
        );
      },
    );
    nameController.dispose();
    if (result == null || result.isEmpty) {
      return;
    }
    final String basePath = controller.fileList?.path ?? '/';
    final String targetPath = basePath == '/'
        ? '/$result'
        : '$basePath/$result';
    await controller.createDirectory(targetPath);
  }
}

class _FileBrowser extends StatefulWidget {
  const _FileBrowser({required this.controller, required this.onCreateDir});

  final ManyoyoAppController controller;
  final Future<void> Function() onCreateDir;

  @override
  State<_FileBrowser> createState() => _FileBrowserState();
}

class _FileBrowserState extends State<_FileBrowser> {
  late final TextEditingController _pathController;
  String _lastListedPath = '';

  @override
  void initState() {
    super.initState();
    _pathController = TextEditingController(
      text: widget.controller.fileList?.path ?? '/',
    );
  }

  @override
  void didUpdateWidget(covariant _FileBrowser oldWidget) {
    super.didUpdateWidget(oldWidget);
    final String nextPath = widget.controller.fileList?.path ?? '/';
    if (nextPath != _lastListedPath) {
      _lastListedPath = nextPath;
      _pathController.text = nextPath;
    }
  }

  @override
  void dispose() {
    _pathController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    final FileListResult? list = controller.fileList;
    final String parentPath = list?.parentPath ?? '';
    final List<FileNode> entries = list?.entries ?? const <FileNode>[];

    return Column(
      children: <Widget>[
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.96),
            border: const Border(bottom: BorderSide(color: _WebColors.line)),
          ),
          child: Column(
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: TextField(
                      controller: _pathController,
                      style: _monoStyle(
                        Theme.of(context).textTheme.bodySmall,
                        fontSize: 12,
                      ),
                      decoration: const InputDecoration(
                        hintText: '/',
                        isDense: true,
                      ),
                      onSubmitted: (String value) async {
                        await controller.openDirectory(
                          value.trim().isEmpty ? '/' : value.trim(),
                        );
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    style: _buttonStyle(_ButtonTone.secondary),
                    onPressed: () async {
                      await controller.openDirectory(
                        _pathController.text.trim().isEmpty
                            ? '/'
                            : _pathController.text.trim(),
                      );
                    },
                    child: const Text('访问'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      controller.loadingFiles ? '加载中' : '已就绪',
                      style: Theme.of(
                        context,
                      ).textTheme.labelMedium?.copyWith(fontSize: 12),
                    ),
                  ),
                  FilledButton(
                    style: _buttonStyle(_ButtonTone.secondary),
                    onPressed: controller.loadingFiles
                        ? null
                        : widget.onCreateDir,
                    child: const Text('新建目录'),
                  ),
                ],
              ),
            ],
          ),
        ),
        if (controller.fileError.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
            child: _Banner(
              backgroundColor: _WebColors.dangerSoft,
              borderColor: const Color(0xFFEDC1BC),
              textColor: _WebColors.danger,
              text: controller.fileError,
            ),
          ),
        Expanded(
          child: controller.loadingFiles && list == null
              ? const Center(
                  child: CircularProgressIndicator(
                    strokeWidth: 2.4,
                    color: _WebColors.accent,
                  ),
                )
              : ListView.builder(
                  itemCount: entries.length + (parentPath.isEmpty ? 0 : 1),
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  itemBuilder: (BuildContext context, int index) {
                    if (parentPath.isNotEmpty && index == 0) {
                      return _FileNodeTile(
                        icon: Icons.arrow_upward,
                        title: '..',
                        subtitle: parentPath,
                        metadata: 'parent',
                        selected: false,
                        onTap: () async {
                          await controller.openDirectory(parentPath);
                        },
                      );
                    }
                    final int offset = parentPath.isNotEmpty ? 1 : 0;
                    final FileNode entry = entries[index - offset];
                    final bool isDir = entry.kind == 'directory';
                    return _FileNodeTile(
                      icon: isDir
                          ? Icons.folder_outlined
                          : Icons.insert_drive_file_outlined,
                      title: entry.name,
                      subtitle: entry.path,
                      metadata: _formatFileNodeMeta(entry),
                      selected: controller.fileRead?.path == entry.path,
                      onTap: () async {
                        if (isDir) {
                          await controller.openDirectory(entry.path);
                        } else {
                          await controller.openFile(entry.path);
                        }
                      },
                    );
                  },
                ),
        ),
      ],
    );
  }
}

class _FileNodeTile extends StatelessWidget {
  const _FileNodeTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.metadata,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String metadata;
  final bool selected;
  final Future<void> Function() onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () async {
          await onTap();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? const Color(0xFFFDF0DA) : Colors.transparent,
            border: Border(
              left: BorderSide(
                color: selected ? const Color(0x94784E1B) : Colors.transparent,
                width: 3,
              ),
              bottom: const BorderSide(color: Color(0x2FB59263)),
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(icon, size: 18, color: _WebColors.muted),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                      ),
                      softWrap: true,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(fontSize: 12),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                metadata,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(fontSize: 11),
                textAlign: TextAlign.right,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FileEditor extends StatelessWidget {
  const _FileEditor({required this.controller, required this.editorController});

  final ManyoyoAppController controller;
  final TextEditingController editorController;

  @override
  Widget build(BuildContext context) {
    final FileReadResult? file = controller.fileRead;
    return file == null
        ? const _EmptyPanelBody(message: '从左侧选择一个文件')
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.96),
                  border: const Border(
                    bottom: BorderSide(color: _WebColors.line),
                  ),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            file.path,
                            style: _displayStyle(
                              Theme.of(context).textTheme.titleSmall,
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            file.isText
                                ? '语言：${file.language} · ${file.size} bytes'
                                : '当前文件不是可编辑文本文件',
                            style: Theme.of(
                              context,
                            ).textTheme.bodySmall?.copyWith(fontSize: 11),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    FilledButton(
                      style: _buttonStyle(_ButtonTone.primary),
                      onPressed: !file.editable || controller.savingFile
                          ? null
                          : () => controller.saveOpenedFile(
                              editorController.text,
                            ),
                      child: Text(controller.savingFile ? '保存中…' : '保存文件'),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Column(
                    children: <Widget>[
                      if (file.truncated)
                        const Padding(
                          padding: EdgeInsets.only(bottom: 8),
                          child: _Banner(
                            backgroundColor: Color(0xFFFFF0DD),
                            borderColor: Color(0xFFEDC98E),
                            textColor: Color(0xFF9A5A09),
                            text: '当前文件内容已截断显示。',
                          ),
                        ),
                      Expanded(
                        child: file.isText
                            ? Container(
                                decoration: BoxDecoration(
                                  color: Colors.white.withValues(alpha: 0.98),
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(
                                    color: const Color(0x33B59263),
                                  ),
                                ),
                                padding: const EdgeInsets.all(8),
                                child: TextField(
                                  controller: editorController,
                                  expands: true,
                                  maxLines: null,
                                  minLines: null,
                                  style: _monoStyle(
                                    Theme.of(context).textTheme.bodyMedium,
                                    fontSize: 13,
                                    height: 1.45,
                                  ),
                                  decoration: const InputDecoration(
                                    border: InputBorder.none,
                                    enabledBorder: InputBorder.none,
                                    focusedBorder: InputBorder.none,
                                    contentPadding: EdgeInsets.zero,
                                  ),
                                ),
                              )
                            : const _EmptyPanelBody(message: '暂不支持二进制文件预览'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
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
  late final FocusNode _terminalFocusNode;

  @override
  void initState() {
    super.initState();
    _inputController = TextEditingController();
    _terminalFocusNode = FocusNode(debugLabel: 'manyoyoTerminalFocus');
  }

  @override
  void dispose() {
    _inputController.dispose();
    _terminalFocusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    if (controller.activeSessionName.isEmpty) {
      return const _EmptyPane(message: '先选择会话再连接终端');
    }
    return Container(
      decoration: _paneDecoration(dark: true),
      child: Column(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            decoration: const BoxDecoration(
              color: Color(0xFF1A1A1A),
              border: Border(bottom: BorderSide(color: Color(0x14FFFFFF))),
            ),
            child: Wrap(
              spacing: 4,
              runSpacing: 4,
              children: <Widget>[
                _TermKeyButton(
                  label: 'esc',
                  onPressed: () {
                    controller.sendTerminalInput('\u001b');
                  },
                ),
                _TermKeyButton(
                  label: 'tab',
                  onPressed: () {
                    controller.sendTerminalInput('\t');
                  },
                ),
                _TermKeyButton(
                  label: 'ctrl+c',
                  active: true,
                  onPressed: () {
                    controller.sendTerminalControlC();
                  },
                ),
                _TermKeyButton(
                  label: '◀',
                  onPressed: () {
                    controller.sendTerminalInput('\u001b[D');
                  },
                ),
                _TermKeyButton(
                  label: '▲',
                  onPressed: () {
                    controller.sendTerminalInput('\u001b[A');
                  },
                ),
                _TermKeyButton(
                  label: '▼',
                  onPressed: () {
                    controller.sendTerminalInput('\u001b[B');
                  },
                ),
                _TermKeyButton(
                  label: '▶',
                  onPressed: () {
                    controller.sendTerminalInput('\u001b[C');
                  },
                ),
                _TermKeyButton(
                  label: '刷新',
                  onPressed: () async {
                    await controller.connectTerminal();
                  },
                ),
              ],
            ),
          ),
          if (controller.terminalError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
              child: _Banner(
                backgroundColor: const Color(0xFF2A1617),
                borderColor: const Color(0xFF74363B),
                textColor: const Color(0xFFFFBAB0),
                text: controller.terminalError,
              ),
            ),
          Expanded(
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              child: KeyboardListener(
                focusNode: _terminalFocusNode,
                onKeyEvent: _handleTerminalKeyEvent,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    _terminalFocusNode.requestFocus();
                  },
                  child: Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: _WebColors.terminalBg,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Stack(
                      children: <Widget>[
                        Positioned.fill(
                          child: SingleChildScrollView(
                            child: SelectableText(
                              controller.terminalOutput.isEmpty
                                  ? '终端输出会显示在这里。点击这里后可直接键盘交互。'
                                  : controller.terminalOutput,
                              style: _monoStyle(
                                Theme.of(context).textTheme.bodyMedium,
                                color: _WebColors.terminalFg,
                                height: 1.35,
                              ),
                            ),
                          ),
                        ),
                        Positioned(
                          right: 0,
                          top: 0,
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.08),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: Colors.white.withValues(alpha: 0.12),
                              ),
                            ),
                            child: Text(
                              _terminalFocusNode.hasFocus ? '键盘已接管' : '点击进入交互',
                              style: _monoStyle(
                                Theme.of(context).textTheme.labelSmall,
                                color: const Color(0xFFBBBBBB),
                                fontSize: 11,
                              ),
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
          Container(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: TextField(
                    controller: _inputController,
                    style: _monoStyle(
                      Theme.of(context).textTheme.bodyMedium,
                      color: _WebColors.text,
                    ),
                    decoration: InputDecoration(
                      hintText: '终端输入 · 当前状态 ${controller.terminalStatus}',
                      fillColor: const Color(0xFFFFFCF7),
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton(
                  style: _buttonStyle(_ButtonTone.primary),
                  onPressed: _submit,
                  child: const Text('发送'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _submit() {
    final String text = _inputController.text;
    if (text.trim().isEmpty) {
      return;
    }
    widget.controller.sendTerminalLine(text);
    _inputController.clear();
  }

  void _handleTerminalKeyEvent(KeyEvent event) {
    if (event is! KeyDownEvent) {
      return;
    }
    final String? data = _keyEventToTerminalData(event);
    if (data == null || data.isEmpty) {
      return;
    }
    widget.controller.sendTerminalInput(data);
  }
}

class _TermKeyButton extends StatelessWidget {
  const _TermKeyButton({
    required this.label,
    required this.onPressed,
    this.active = false,
  });

  final String label;
  final VoidCallback onPressed;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
        minimumSize: const Size(0, 28),
        backgroundColor: active
            ? _WebColors.accent
            : Colors.white.withValues(alpha: 0.07),
        foregroundColor: active ? Colors.white : const Color(0xFFBBBBBB),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(4),
          side: BorderSide(
            color: active
                ? _WebColors.accentStrong
                : Colors.white.withValues(alpha: 0.13),
          ),
        ),
      ),
      onPressed: onPressed,
      child: Text(label, style: _monoStyle(const TextStyle(fontSize: 12))),
    );
  }
}

class _DetailPane extends StatelessWidget {
  const _DetailPane({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    final SessionDetail? detail = controller.activeSessionDetail;
    if (controller.activeSessionName.isEmpty) {
      return const _EmptyPane(message: '先选择会话再查看详情');
    }
    if (detail == null && controller.loadingSessionContent) {
      return Container(
        decoration: _paneDecoration(),
        child: const Center(
          child: CircularProgressIndicator(
            strokeWidth: 2.4,
            color: _WebColors.accent,
          ),
        ),
      );
    }
    if (detail == null) {
      return const _EmptyPane(message: '当前会话详情暂不可用');
    }
    return _InspectorPane(
      cards: <Widget>[
        _InfoCard(
          title: '会话概览',
          description: '当前容器会话的运行状态、镜像和时间信息。',
          child: Column(
            children: <Widget>[
              _KvRow(label: '名称', value: detail.name, first: true),
              _KvRow(label: '容器', value: detail.containerName),
              _KvRow(
                label: '状态',
                value: detail.status,
                tone: _statusToneLabel(detail.status),
              ),
              _KvRow(label: '镜像', value: detail.image),
              _KvRow(label: '创建时间', value: detail.createdAt),
              _KvRow(label: '更新时间', value: detail.updatedAt),
            ],
          ),
        ),
        _InfoCard(
          title: 'Agent',
          description: 'Agent 识别、resume 能力与提示词命令来源。',
          child: Column(
            children: <Widget>[
              _KvRow(label: 'Agent 名称', value: detail.agentName, first: true),
              _KvRow(label: 'Agent ID', value: detail.agentId),
              _KvRow(
                label: '启用',
                value: detail.agentEnabled ? 'yes' : 'no',
                tone: detail.agentEnabled ? _KvTone.ok : _KvTone.warn,
              ),
              _KvRow(
                label: 'Resume',
                value: detail.resumeSupported ? 'supported' : 'unsupported',
                tone: detail.resumeSupported ? _KvTone.ok : _KvTone.warn,
              ),
              _KvRow(label: 'CLI', value: detail.agentProgram),
              _KvRow(label: '来源', value: detail.agentPromptSource),
              _KvRow(
                label: '命令',
                value: _firstNonEmpty(<String>[
                  detail.containerAgentPromptCommand,
                  detail.agentPromptCommandOverride,
                  detail.inferredAgentPromptCommand,
                  detail.agentPromptCommand,
                ]),
              ),
            ],
          ),
        ),
        _InfoCard(
          title: '挂载路径',
          description: '宿主机与容器内工作目录路径。',
          child: Column(
            children: <Widget>[
              _KvRow(label: '宿主路径', value: detail.hostPath, first: true),
              _KvRow(label: '容器路径', value: detail.containerPath),
              _KvRow(label: '最近角色', value: detail.latestRole),
              _KvRow(label: '最近时间', value: detail.latestTimestamp),
            ],
          ),
        ),
        _InfoCard(
          title: 'Applied',
          description: '当前会话合并后的关键配置快照。',
          child: SelectableText(
            _prettyJson.convert(detail.applied),
            style: _monoStyle(
              Theme.of(context).textTheme.bodySmall,
              color: _WebColors.text,
              height: 1.5,
            ),
          ),
        ),
      ],
    );
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
    final String path = widget.controller.configSnapshot?.path ?? '';
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
    final ManyoyoAppController controller = widget.controller;
    final ConfigSnapshot? snapshot = controller.configSnapshot;
    return Container(
      decoration: _paneDecoration(),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    snapshot?.path ?? '~/.manyoyo/manyoyo.json',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                FilledButton(
                  style: _buttonStyle(_ButtonTone.secondary),
                  onPressed: controller.loadingConfig
                      ? null
                      : controller.loadConfig,
                  child: const Text('刷新'),
                ),
              ],
            ),
            const SizedBox(height: 10),
            if ((snapshot?.notice ?? '').isNotEmpty)
              _Banner(
                backgroundColor: _WebColors.panelSoft,
                borderColor: _WebColors.line,
                textColor: _WebColors.text,
                text: snapshot!.notice,
              ),
            if ((snapshot?.parseError ?? '').isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              _Banner(
                backgroundColor: _WebColors.dangerSoft,
                borderColor: const Color(0xFFEDC1BC),
                textColor: _WebColors.danger,
                text: snapshot!.parseError,
              ),
            ],
            if (controller.configError.isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              _Banner(
                backgroundColor: _WebColors.dangerSoft,
                borderColor: const Color(0xFFEDC1BC),
                textColor: _WebColors.danger,
                text: controller.configError,
              ),
            ],
            const SizedBox(height: 12),
            Expanded(
              child: controller.loadingConfig && snapshot == null
                  ? const Center(
                      child: CircularProgressIndicator(
                        strokeWidth: 2.4,
                        color: _WebColors.accent,
                      ),
                    )
                  : TextField(
                      controller: _configController,
                      expands: true,
                      maxLines: null,
                      minLines: null,
                      style: _monoStyle(
                        Theme.of(context).textTheme.bodyMedium,
                        fontSize: 13,
                        height: 1.5,
                      ),
                      decoration: const InputDecoration(),
                    ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              style: _buttonStyle(_ButtonTone.primary),
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

class _ConfigEditorDialog extends StatefulWidget {
  const _ConfigEditorDialog({required this.controller});

  final ManyoyoAppController controller;

  @override
  State<_ConfigEditorDialog> createState() => _ConfigEditorDialogState();
}

class _ConfigEditorDialogState extends State<_ConfigEditorDialog> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(
      text: widget.controller.configSnapshot?.raw ?? '',
    );
  }

  @override
  void didUpdateWidget(covariant _ConfigEditorDialog oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.text = widget.controller.configSnapshot?.raw ?? '';
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    final ConfigSnapshot? snapshot = controller.configSnapshot;
    return AlertDialog(
      title: Text('编辑配置 (${snapshot?.path ?? '~/.manyoyo/manyoyo.json'})'),
      content: SizedBox(
        width: 960,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if ((snapshot?.notice ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  snapshot!.notice,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            if ((snapshot?.parseError ?? '').isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  snapshot!.parseError,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: _WebColors.danger,
                  ),
                ),
              ),
            if (controller.configError.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  controller.configError,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: _WebColors.danger,
                  ),
                ),
              ),
            Flexible(
              child: TextField(
                controller: _controller,
                expands: true,
                maxLines: null,
                minLines: null,
                style: _monoStyle(
                  Theme.of(context).textTheme.bodyMedium,
                  fontSize: 13,
                  height: 1.5,
                ),
                decoration: const InputDecoration(),
              ),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: controller.loadingConfig ? null : controller.loadConfig,
          child: const Text('重新加载'),
        ),
        FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: controller.savingConfig
              ? null
              : () => Navigator.of(context).pop(),
          child: const Text('关闭'),
        ),
        FilledButton(
          style: _buttonStyle(_ButtonTone.primary),
          onPressed: controller.savingConfig
              ? null
              : () async {
                  await controller.saveConfig(_controller.text);
                  if (!mounted || controller.configError.isNotEmpty) {
                    return;
                  }
                  setState(() {
                    _controller.text = controller.configSnapshot?.raw ?? '';
                  });
                },
          child: Text(controller.savingConfig ? '保存中…' : '保存'),
        ),
      ],
    );
  }
}

class _AgentTemplateDialog extends StatefulWidget {
  const _AgentTemplateDialog({required this.controller});

  final ManyoyoAppController controller;

  @override
  State<_AgentTemplateDialog> createState() => _AgentTemplateDialogState();
}

class _AgentTemplateDialogState extends State<_AgentTemplateDialog> {
  late final TextEditingController _commandController;
  late String _cli;

  SessionDetail get _detail => widget.controller.activeSessionDetail!;

  bool get _overrideEditable => _detail.agentId != 'default';

  @override
  void initState() {
    super.initState();
    final String initialText = _overrideEditable
        ? (_detail.agentPromptCommandOverride.isNotEmpty
              ? _detail.agentPromptCommandOverride
              : _detail.containerAgentPromptCommand)
        : (_detail.containerAgentPromptCommand.isNotEmpty
              ? _detail.containerAgentPromptCommand
              : _detail.agentPromptCommand);
    _commandController = TextEditingController(text: initialText);
    _cli = _inferTemplateCliValue(initialText);
  }

  @override
  void dispose() {
    _commandController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ManyoyoAppController controller = widget.controller;
    return AlertDialog(
      title: const Text('设置 CLI / Agent 模板'),
      content: SizedBox(
        width: 720,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            DropdownButtonFormField<String>(
              initialValue: _cli,
              decoration: const InputDecoration(labelText: 'CLI'),
              items: const <DropdownMenuItem<String>>[
                DropdownMenuItem<String>(value: '', child: Text('自定义')),
                DropdownMenuItem<String>(
                  value: 'claude',
                  child: Text('claude'),
                ),
                DropdownMenuItem<String>(value: 'codex', child: Text('codex')),
                DropdownMenuItem<String>(
                  value: 'gemini',
                  child: Text('gemini'),
                ),
                DropdownMenuItem<String>(
                  value: 'opencode',
                  child: Text('opencode'),
                ),
              ],
              onChanged: (String? value) {
                setState(() {
                  _cli = value ?? '';
                  final String nextTemplate = _templateForCli(_cli);
                  if (nextTemplate.isNotEmpty) {
                    _commandController.text = nextTemplate;
                  }
                });
              },
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _commandController,
              minLines: 3,
              maxLines: 5,
              style: _monoStyle(
                Theme.of(context).textTheme.bodyMedium,
                fontSize: 13,
                height: 1.5,
              ),
              decoration: InputDecoration(
                labelText: _overrideEditable
                    ? '高级编辑 agentPromptCommandOverride'
                    : '高级编辑 agentPromptCommand',
                hintText: '例如 codex exec --skip-git-repo-check {prompt}',
              ),
            ),
            if (controller.workspaceError.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              Text(
                controller.workspaceError,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: _WebColors.danger,
                ),
              ),
            ],
          ],
        ),
      ),
      actions: <Widget>[
        FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: controller.savingAgentTemplate
              ? null
              : () {
                  final String resetText = _overrideEditable
                      ? (_detail.agentPromptCommandOverride.isNotEmpty
                            ? _detail.agentPromptCommandOverride
                            : _detail.containerAgentPromptCommand)
                      : (_detail.containerAgentPromptCommand.isNotEmpty
                            ? _detail.containerAgentPromptCommand
                            : _detail.agentPromptCommand);
                  setState(() {
                    _commandController.text = resetText;
                    _cli = _inferTemplateCliValue(resetText);
                  });
                },
          child: const Text('恢复当前值'),
        ),
        FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: controller.savingAgentTemplate
              ? null
              : () => Navigator.of(context).pop(),
          child: const Text('关闭'),
        ),
        FilledButton(
          style: _buttonStyle(_ButtonTone.primary),
          onPressed: controller.savingAgentTemplate
              ? null
              : () async {
                  final String value = _commandController.text.trim();
                  await controller.saveAgentTemplate(
                    containerAgentPromptCommand: _overrideEditable ? null : value,
                    agentPromptCommandOverride: _overrideEditable ? value : null,
                  );
                  if (!context.mounted || controller.workspaceError.isNotEmpty) {
                    return;
                  }
                  Navigator.of(context).pop();
                },
          child: Text(controller.savingAgentTemplate ? '保存中…' : '保存'),
        ),
      ],
    );
  }
}

class _CheckPane extends StatelessWidget {
  const _CheckPane({required this.controller});

  final ManyoyoAppController controller;

  @override
  Widget build(BuildContext context) {
    final SessionDetail? detail = controller.activeSessionDetail;
    final ConfigSnapshot? config = controller.configSnapshot;
    if (controller.activeSessionName.isEmpty) {
      return const _EmptyPane(message: '先选择会话再查看检查项');
    }
    return _InspectorPane(
      cards: <Widget>[
        _InfoCard(
          title: '运行检查',
          description: '当前会话最核心的状态健康项。',
          child: Column(
            children: <Widget>[
              _CheckItem(
                label: '容器状态',
                value: detail?.status.isNotEmpty == true
                    ? detail!.status
                    : 'unknown',
                detail: detail == null ? '尚未加载详情。' : '会话当前容器运行状态。',
                tone: detail?.status == 'running'
                    ? _KvTone.ok
                    : detail == null
                    ? _KvTone.warn
                    : _KvTone.warn,
              ),
              _CheckItem(
                label: 'Agent 支持 resume',
                value: detail?.resumeSupported == true ? 'yes' : 'no',
                detail: '决定是否可以安全走 resume 与提示词模板推断链路。',
                tone: detail?.resumeSupported == true
                    ? _KvTone.ok
                    : _KvTone.warn,
              ),
              _CheckItem(
                label: '消息流',
                value: controller.streamingAgent ? 'running' : 'idle',
                detail: controller.liveTrace.isEmpty
                    ? '当前没有进行中的 Agent 流式输出。'
                    : controller.liveTrace,
                tone: controller.streamingAgent ? _KvTone.ok : _KvTone.warn,
              ),
            ],
          ),
        ),
        _InfoCard(
          title: '配置检查',
          description: '全局配置文件加载和解析状态。',
          child: Column(
            children: <Widget>[
              _CheckItem(
                label: '配置已加载',
                value: config == null ? 'no' : 'yes',
                detail: config?.path ?? '尚未拉取配置文件。',
                tone: config == null ? _KvTone.warn : _KvTone.ok,
              ),
              _CheckItem(
                label: '配置可编辑',
                value: config?.editable == true ? 'yes' : 'no',
                detail: config?.notice.isNotEmpty == true
                    ? config!.notice
                    : '当前是否允许直接保存配置文件。',
                tone: config?.editable == true ? _KvTone.ok : _KvTone.warn,
              ),
              _CheckItem(
                label: '解析错误',
                value: (config?.parseError ?? '').isEmpty ? 'none' : 'found',
                detail: (config?.parseError ?? '').isEmpty
                    ? '配置 JSON5 解析正常。'
                    : config!.parseError,
                tone: (config?.parseError ?? '').isEmpty
                    ? _KvTone.ok
                    : _KvTone.danger,
              ),
            ],
          ),
        ),
        _InfoCard(
          title: '路径与挂载',
          description: '工作目录路径与容器路径是否明确。',
          child: Column(
            children: <Widget>[
              _KvRow(
                label: '宿主路径',
                value: detail?.hostPath ?? '',
                tone: (detail?.hostPath ?? '').isEmpty
                    ? _KvTone.warn
                    : _KvTone.ok,
                first: true,
              ),
              _KvRow(
                label: '容器路径',
                value: detail?.containerPath ?? '',
                tone: (detail?.containerPath ?? '').isEmpty
                    ? _KvTone.warn
                    : _KvTone.ok,
              ),
              _KvRow(
                label: 'CLI',
                value: detail?.agentProgram ?? '',
                tone: (detail?.agentProgram ?? '').isEmpty
                    ? _KvTone.warn
                    : _KvTone.ok,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _InspectorPane extends StatelessWidget {
  const _InspectorPane({required this.cards});

  final List<Widget> cards;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: _paneDecoration(),
      child: ListView.separated(
        padding: const EdgeInsets.all(14),
        itemCount: cards.length,
        separatorBuilder: (_, _) => const SizedBox(height: 12),
        itemBuilder: (BuildContext context, int index) => cards[index],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({
    required this.title,
    required this.description,
    required this.child,
  });

  final String title;
  final String description;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0x66B59263)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            title,
            style: _displayStyle(
              Theme.of(context).textTheme.titleMedium,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            description,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(fontSize: 13),
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}

enum _KvTone { normal, ok, warn, danger }

class _KvRow extends StatelessWidget {
  const _KvRow({
    required this.label,
    required this.value,
    this.tone = _KvTone.normal,
    this.first = false,
  });

  final String label;
  final String value;
  final _KvTone tone;
  final bool first;

  @override
  Widget build(BuildContext context) {
    final Color color = switch (tone) {
      _KvTone.ok => _WebColors.subaccentStrong,
      _KvTone.warn => const Color(0xFF9A5A09),
      _KvTone.danger => _WebColors.danger,
      _KvTone.normal => _WebColors.text,
    };
    return Container(
      padding: EdgeInsets.only(top: first ? 0 : 8),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(
            color: first ? Colors.transparent : const Color(0x57B59263),
          ),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 108,
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              value.isEmpty ? '—' : value,
              style: _monoStyle(
                Theme.of(context).textTheme.bodySmall,
                color: color,
                fontSize: 12,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CheckItem extends StatelessWidget {
  const _CheckItem({
    required this.label,
    required this.value,
    required this.detail,
    required this.tone,
  });

  final String label;
  final String value;
  final String detail;
  final _KvTone tone;

  @override
  Widget build(BuildContext context) {
    final Color color = switch (tone) {
      _KvTone.ok => _WebColors.subaccentStrong,
      _KvTone.warn => const Color(0xFF9A5A09),
      _KvTone.danger => _WebColors.danger,
      _KvTone.normal => _WebColors.text,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xDBFFFDF6),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0x47B59263)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  label,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                  ),
                ),
              ),
              Text(
                value,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                  color: color,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            detail,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _CreateSessionDialog extends StatefulWidget {
  const _CreateSessionDialog({required this.controller, required this.seed});

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
  late final TextEditingController _shellPrefixController;
  late final TextEditingController _shellController;
  late final TextEditingController _shellSuffixController;
  late final TextEditingController _agentPromptCommandController;
  late final TextEditingController _envController;
  late final TextEditingController _envFileController;
  late final TextEditingController _volumesController;
  String _run = '';
  String _containerMode = '';
  String _yolo = '';

  @override
  void initState() {
    super.initState();
    _containerNameController = TextEditingController();
    _hostPathController = TextEditingController();
    _containerPathController = TextEditingController();
    _imageNameController = TextEditingController();
    _imageVersionController = TextEditingController();
    _shellPrefixController = TextEditingController();
    _shellController = TextEditingController();
    _shellSuffixController = TextEditingController();
    _agentPromptCommandController = TextEditingController();
    _envController = TextEditingController();
    _envFileController = TextEditingController();
    _volumesController = TextEditingController();
    _applyDefaults();
  }

  @override
  void dispose() {
    _containerNameController.dispose();
    _hostPathController.dispose();
    _containerPathController.dispose();
    _imageNameController.dispose();
    _imageVersionController.dispose();
    _shellPrefixController.dispose();
    _shellController.dispose();
    _shellSuffixController.dispose();
    _agentPromptCommandController.dispose();
    _envController.dispose();
    _envFileController.dispose();
    _volumesController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final List<String> runNames = widget.seed.runs.keys.toList()..sort();
    return AlertDialog(
      title: const Text('新建容器会话'),
      content: SizedBox(
        width: 880,
        child: SingleChildScrollView(
          child: Column(
            children: <Widget>[
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: <Widget>[
                  SizedBox(
                    width: 400,
                    child: DropdownButtonFormField<String>(
                      initialValue: _run,
                      decoration: const InputDecoration(labelText: 'run'),
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
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogPathField(
                      controller: _hostPathController,
                      label: 'hostPath',
                      hintText: '/abs/path/project',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _containerNameController,
                      'containerName',
                      hintText: 'my-dev 或 my-{now}',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _containerPathController,
                      'containerPath',
                      hintText: '/workspace',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _imageNameController,
                      'imageName',
                      hintText: 'localhost/xcanwin/manyoyo',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _imageVersionController,
                      'imageVersion',
                      hintText: '1.7.4-common',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: DropdownButtonFormField<String>(
                      initialValue: _containerMode,
                      decoration: const InputDecoration(
                        labelText: 'containerMode',
                      ),
                      items: const <DropdownMenuItem<String>>[
                        DropdownMenuItem<String>(
                          value: '',
                          child: Text('(跟随默认)'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'common',
                          child: Text('common'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'dind',
                          child: Text('dind'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'sock',
                          child: Text('sock'),
                        ),
                      ],
                      onChanged: (String? value) {
                        setState(() {
                          _containerMode = value ?? '';
                        });
                      },
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _shellPrefixController,
                      'shellPrefix',
                      hintText: '例如 IS_SANDBOX=1',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _shellController,
                      'shell',
                      hintText: '例如 claude / codex',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: _dialogField(
                      _shellSuffixController,
                      'shellSuffix',
                      hintText: '例如 --dangerously-skip-permissions',
                    ),
                  ),
                  SizedBox(
                    width: 400,
                    child: DropdownButtonFormField<String>(
                      initialValue: _yolo,
                      decoration: const InputDecoration(labelText: 'CLI'),
                      items: const <DropdownMenuItem<String>>[
                        DropdownMenuItem<String>(
                          value: '',
                          child: Text('(不使用)'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'claude',
                          child: Text('claude'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'codex',
                          child: Text('codex'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'gemini',
                          child: Text('gemini'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'opencode',
                          child: Text('opencode'),
                        ),
                      ],
                      onChanged: (String? value) {
                        setState(() {
                          _yolo = value ?? '';
                        });
                      },
                    ),
                  ),
                  SizedBox(
                    width: 812,
                    child: _dialogField(
                      _agentPromptCommandController,
                      'agentPromptCommand',
                      hintText: '例如 codex exec --plain-text {prompt}',
                    ),
                  ),
                  SizedBox(
                    width: 812,
                    child: _dialogMultilineField(
                      controller: _envController,
                      label: 'env (KEY=VALUE，每行一项)',
                    ),
                  ),
                  SizedBox(
                    width: 812,
                    child: _dialogMultilineField(
                      controller: _envFileController,
                      label: 'envFile (绝对路径，每行一项)',
                      hintText: '/abs/path/.env',
                    ),
                  ),
                  SizedBox(
                    width: 812,
                    child: _dialogMultilineField(
                      controller: _volumesController,
                      label: 'volumes (每行一项)',
                      hintText: '/host/path:/container/path',
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
      actions: <Widget>[
        FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: widget.controller.creatingSession
              ? null
              : () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          style: _buttonStyle(_ButtonTone.primary),
          onPressed: widget.controller.creatingSession ? null : _submit,
          child: Text(widget.controller.creatingSession ? '创建中…' : '创建'),
        ),
      ],
    );
  }

  Widget _dialogField(
    TextEditingController controller,
    String label, {
    String? hintText,
  }) {
    return TextField(
      controller: controller,
      decoration: InputDecoration(labelText: label, hintText: hintText),
    );
  }

  Widget _dialogMultilineField({
    required TextEditingController controller,
    required String label,
    String? hintText,
  }) {
    return TextField(
      controller: controller,
      minLines: 3,
      maxLines: 5,
      style: _monoStyle(const TextStyle(fontSize: 13, height: 1.5)),
      decoration: InputDecoration(labelText: label, hintText: hintText),
    );
  }

  Widget _dialogPathField({
    required TextEditingController controller,
    required String label,
    String? hintText,
  }) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: <Widget>[
        Expanded(child: _dialogField(controller, label, hintText: hintText)),
        const SizedBox(width: 8),
        FilledButton(
          style: _buttonStyle(_ButtonTone.secondary),
          onPressed: _pickHostPath,
          child: const Text('选择'),
        ),
      ],
    );
  }

  void _applyDefaults() {
    final Map<String, dynamic> defaults = Map<String, dynamic>.from(
      widget.seed.defaults,
    );
    final Map<String, dynamic> runConfig =
        widget.seed.runs[_run] ?? const <String, dynamic>{};
    defaults.addAll(runConfig);
    _containerNameController.text = asString(defaults['containerName']);
    _hostPathController.text = asString(defaults['hostPath']);
    _containerPathController.text = asString(defaults['containerPath']);
    _imageNameController.text = asString(defaults['imageName']);
    _imageVersionController.text = asString(defaults['imageVersion']);
    _containerMode = asString(defaults['containerMode']);
    _shellPrefixController.text = asString(defaults['shellPrefix']);
    _shellController.text = asString(defaults['shell']);
    _shellSuffixController.text = asString(defaults['shellSuffix']);
    _agentPromptCommandController.text = asString(
      defaults['agentPromptCommand'],
    );
    _yolo = asString(defaults['yolo']);
    _envController.text = _formatEnvMap(defaults['env']);
    _envFileController.text = _formatStringList(defaults['envFile']);
    _volumesController.text = _formatStringList(defaults['volumes']);
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
        containerMode: _containerMode,
        shellPrefix: _shellPrefixController.text,
        shell: _shellController.text,
        shellSuffix: _shellSuffixController.text,
        agentPromptCommand: _agentPromptCommandController.text,
        yolo: _yolo,
        env: _parseEnvMap(_envController.text),
        envFile: _parseMultilineList(_envFileController.text),
        volumes: _parseMultilineList(_volumesController.text),
      ),
    );
    if (mounted && widget.controller.workspaceError.isEmpty) {
      Navigator.of(context).pop();
    }
  }

  Future<void> _pickHostPath() async {
    final String? path = await getDirectoryPath(
      initialDirectory: _hostPathController.text.trim().isEmpty
          ? null
          : _hostPathController.text.trim(),
      confirmButtonText: '选择',
    );
    if (path == null || path.trim().isEmpty || !mounted) {
      return;
    }
    setState(() {
      _hostPathController.text = path;
    });
  }
}

class _LabeledField extends StatelessWidget {
  const _LabeledField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.2,
          ),
        ),
        const SizedBox(height: 6),
        child,
      ],
    );
  }
}

String _formatEnvMap(Object? value) {
  final Map<String, dynamic> env = asJsonMap(value);
  if (env.isEmpty) {
    return '';
  }
  return env.entries
      .map((MapEntry<String, dynamic> entry) => '${entry.key}=${entry.value}')
      .join('\n');
}

String _formatStringList(Object? value) {
  final List<dynamic> items = asJsonList(value);
  if (items.isEmpty) {
    return '';
  }
  return items.map((dynamic item) => '$item').join('\n');
}

Map<String, String> _parseEnvMap(String text) {
  final Map<String, String> env = <String, String>{};
  for (final String rawLine in text.split('\n')) {
    final String line = rawLine.trim();
    if (line.isEmpty) {
      continue;
    }
    final int separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    env[line.substring(0, separator).trim()] = line
        .substring(separator + 1)
        .trim();
  }
  return env;
}

List<String> _parseMultilineList(String text) {
  return text
      .split('\n')
      .map((String line) => line.trim())
      .where((String line) => line.isNotEmpty)
      .toList();
}

class _SidebarDirectoryGroup {
  const _SidebarDirectoryGroup({
    required this.path,
    required this.updatedAt,
    required this.containers,
  });

  final String path;
  final String updatedAt;
  final List<_SidebarContainerGroup> containers;
}

class _SidebarContainerGroup {
  const _SidebarContainerGroup({
    required this.path,
    required this.container,
    required this.status,
    required this.updatedAt,
    required this.sessions,
  });

  final String path;
  final String container;
  final String status;
  final String updatedAt;
  final List<SessionSummary> sessions;
}

class _SidebarStatusInfo {
  const _SidebarStatusInfo({
    required this.tone,
    required this.label,
    required this.color,
  });

  final String tone;
  final String label;
  final Color color;
}

String _sidebarContainerKey(String path, String container) {
  return '$path::$container';
}

List<_SidebarDirectoryGroup> _groupSessionsByDirectory(
  List<SessionSummary> sessions,
) {
  final Map<String, List<SessionSummary>> grouped =
      <String, List<SessionSummary>>{};
  for (final SessionSummary session in sessions) {
    final String path = session.hostPath.trim().isEmpty
        ? '未配置目录'
        : session.hostPath.trim();
    grouped.putIfAbsent(path, () => <SessionSummary>[]).add(session);
  }
  final List<_SidebarDirectoryGroup> result =
      grouped.entries.map((MapEntry<String, List<SessionSummary>> entry) {
        final Map<String, List<SessionSummary>> containerMap =
            <String, List<SessionSummary>>{};
        for (final SessionSummary session in entry.value) {
          containerMap
              .putIfAbsent(session.containerName, () => <SessionSummary>[])
              .add(session);
        }
        final List<_SidebarContainerGroup> containers =
            containerMap.entries.map((
              MapEntry<String, List<SessionSummary>> item,
            ) {
              final List<SessionSummary> orderedSessions = item.value.toList()
                ..sort(_compareSidebarSessionByCreatedDesc);
              SessionSummary latest = orderedSessions.first;
              for (final SessionSummary session in orderedSessions) {
                if (_sessionTime(session.updatedAt) >
                    _sessionTime(latest.updatedAt)) {
                  latest = session;
                }
              }
              return _SidebarContainerGroup(
                path: entry.key,
                container: item.key,
                status: latest.status,
                updatedAt: latest.updatedAt,
                sessions: orderedSessions,
              );
            }).toList()..sort(
              (_SidebarContainerGroup a, _SidebarContainerGroup b) =>
                  _sessionTime(
                    b.updatedAt,
                  ).compareTo(_sessionTime(a.updatedAt)),
            );
        String updatedAt = '';
        for (final _SidebarContainerGroup container in containers) {
          if (_sessionTime(container.updatedAt) > _sessionTime(updatedAt)) {
            updatedAt = container.updatedAt;
          }
        }
        return _SidebarDirectoryGroup(
          path: entry.key,
          updatedAt: updatedAt,
          containers: containers,
        );
      }).toList()..sort(
        (_SidebarDirectoryGroup a, _SidebarDirectoryGroup b) =>
            _sessionTime(b.updatedAt).compareTo(_sessionTime(a.updatedAt)),
      );
  return result;
}

int _compareSidebarSessionByCreatedDesc(SessionSummary a, SessionSummary b) {
  final int createdDiff = _sessionTime(
    b.createdAt,
  ).compareTo(_sessionTime(a.createdAt));
  if (createdDiff != 0) {
    return createdDiff;
  }
  if (a.containerName == b.containerName) {
    final int rankDiff = _sidebarAgentRank(
      b.agentId,
    ).compareTo(_sidebarAgentRank(a.agentId));
    if (rankDiff != 0) {
      return rankDiff;
    }
  }
  final int updatedDiff = _sessionTime(
    b.updatedAt,
  ).compareTo(_sessionTime(a.updatedAt));
  if (updatedDiff != 0) {
    return updatedDiff;
  }
  return a.name.compareTo(b.name);
}

int _sidebarAgentRank(String agentId) {
  final String value = agentId.trim();
  if (value.isEmpty || value == 'default') {
    return 1;
  }
  final RegExpMatch? matched = RegExp(r'^agent-(\d+)$').firstMatch(value);
  return matched == null ? 0 : int.tryParse(matched.group(1) ?? '0') ?? 0;
}

int _sessionTime(String value) {
  final String text = value.trim();
  if (text.isEmpty) {
    return 0;
  }
  return DateTime.tryParse(text)?.millisecondsSinceEpoch ?? 0;
}

String _formatSidebarDateTime(String value) {
  final DateTime? date = DateTime.tryParse(value.trim());
  if (date == null) {
    return '暂无更新';
  }
  String twoDigits(int source) => source.toString().padLeft(2, '0');
  return '${twoDigits(date.month)}/${twoDigits(date.day)} ${twoDigits(date.hour)}:${twoDigits(date.minute)}';
}

_SidebarStatusInfo _sidebarStatusInfo(String status) {
  final String normalized = status.toLowerCase();
  if (normalized == 'history') {
    return const _SidebarStatusInfo(
      tone: 'history',
      label: '仅历史',
      color: _WebColors.statusHistoryText,
    );
  }
  if (normalized.contains('up') || normalized.contains('running')) {
    return const _SidebarStatusInfo(
      tone: 'running',
      label: '运行中',
      color: _WebColors.statusRunningText,
    );
  }
  if (normalized.contains('exited') || normalized.contains('created')) {
    return const _SidebarStatusInfo(
      tone: 'stopped',
      label: '已停止',
      color: _WebColors.statusStoppedText,
    );
  }
  return const _SidebarStatusInfo(
    tone: 'unknown',
    label: '未知',
    color: _WebColors.statusUnknownText,
  );
}

class _StatusTheme {
  const _StatusTheme({
    required this.background,
    required this.foreground,
    required this.border,
  });

  final Color background;
  final Color foreground;
  final Color border;
}

_StatusTheme _statusTheme(String status) {
  return switch (status) {
    'running' => const _StatusTheme(
      background: _WebColors.statusRunningBg,
      foreground: _WebColors.statusRunningText,
      border: Color(0xFFA9DACF),
    ),
    'stopped' => const _StatusTheme(
      background: _WebColors.statusStoppedBg,
      foreground: _WebColors.statusStoppedText,
      border: Color(0xFFEDC98E),
    ),
    'history' => const _StatusTheme(
      background: _WebColors.statusHistoryBg,
      foreground: _WebColors.statusHistoryText,
      border: Color(0xFFD8CEBE),
    ),
    _ => const _StatusTheme(
      background: _WebColors.statusUnknownBg,
      foreground: _WebColors.statusUnknownText,
      border: Color(0xFFCAC1FB),
    ),
  };
}

_KvTone _statusToneLabel(String status) {
  return switch (status) {
    'running' => _KvTone.ok,
    'stopped' => _KvTone.warn,
    'history' => _KvTone.warn,
    _ => _KvTone.warn,
  };
}

class _InfoChip extends StatelessWidget {
  const _InfoChip({
    required this.label,
    this.tone,
    this.backgroundColor,
    this.foregroundColor,
    this.borderColor,
    this.monospace = false,
  });

  final String label;
  final _StatusTheme? tone;
  final Color? backgroundColor;
  final Color? foregroundColor;
  final Color? borderColor;
  final bool monospace;

  @override
  Widget build(BuildContext context) {
    final Color bg =
        tone?.background ?? backgroundColor ?? _WebColors.panelSoft;
    final Color fg = tone?.foreground ?? foregroundColor ?? _WebColors.text;
    final Color border = tone?.border ?? borderColor ?? _WebColors.line;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: border),
      ),
      child: Text(
        label,
        style: monospace
            ? _monoStyle(
                Theme.of(context).textTheme.labelMedium,
                color: fg,
                fontSize: 12,
              )
            : Theme.of(
                context,
              ).textTheme.labelMedium?.copyWith(color: fg, fontSize: 12),
      ),
    );
  }
}

class _ToolbarChip extends StatelessWidget {
  const _ToolbarChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: _WebColors.panelSoft,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _WebColors.line),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(fontSize: 12),
      ),
    );
  }
}

class _ToolbarButtonChip extends StatelessWidget {
  const _ToolbarButtonChip({required this.label, required this.onPressed});

  final String label;
  final Future<void> Function()? onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      style: _buttonStyle(_ButtonTone.secondary),
      onPressed: onPressed == null
          ? null
          : () async {
              await onPressed!.call();
            },
      child: Text(label),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.activeMode});

  final MessageItem message;
  final String activeMode;

  @override
  Widget build(BuildContext context) {
    final bool isUser = message.role == 'user';
    final bool isSystem = message.role == 'system';
    final bool modeMismatch =
        message.mode.isNotEmpty &&
        message.mode != activeMode &&
        ((activeMode == 'agent' && message.mode == 'command') ||
            (activeMode == 'command' && message.mode == 'agent'));
    final bool streamingReply =
        message.pending && message.role == 'assistant' && !modeMismatch;
    final Color background = isUser
        ? _WebColors.userBubble
        : isSystem
        ? _WebColors.systemBubble
        : _WebColors.assistantBubble;
    final Color border = isUser
        ? const Color(0xFFE9B994)
        : isSystem
        ? const Color(0xFFB8E3DD)
        : streamingReply
        ? _WebColors.subaccent
        : _WebColors.line;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 920),
        child: Column(
          crossAxisAlignment: isUser
              ? CrossAxisAlignment.end
              : CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              '${message.role}${message.pending ? ' · pending' : ''}',
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (message.timestamp.isNotEmpty) ...<Widget>[
              const SizedBox(height: 2),
              Text(
                message.timestamp,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
            if (message.exitCode != null) ...<Widget>[
              const SizedBox(height: 2),
              Text(
                'exitCode ${message.exitCode}',
                style: _monoStyle(
                  Theme.of(context).textTheme.labelSmall,
                  fontSize: 11,
                ),
              ),
            ],
            const SizedBox(height: 6),
            Opacity(
              opacity: modeMismatch
                  ? 0.25
                  : message.pending
                  ? 0.78
                  : 1,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: background,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: border),
                  boxShadow: const <BoxShadow>[
                    BoxShadow(
                      color: Color(0x142E1F0D),
                      blurRadius: 16,
                      offset: Offset(0, 8),
                    ),
                  ],
                ),
                child: SelectableText.rich(
                  TextSpan(
                    style: _monoStyle(
                      Theme.of(context).textTheme.bodyMedium,
                      color: _WebColors.text,
                      fontSize: 13,
                      height: 1.55,
                    ),
                    children: <InlineSpan>[
                      TextSpan(
                        text: message.content.isEmpty ? '…' : message.content,
                      ),
                      if (streamingReply)
                        WidgetSpan(
                          alignment: PlaceholderAlignment.middle,
                          child: Container(
                            width: 7,
                            height: 16,
                            margin: const EdgeInsets.only(left: 2),
                            decoration: BoxDecoration(
                              color: _WebColors.subaccent,
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    required this.backgroundColor,
    required this.borderColor,
    required this.textColor,
    required this.text,
  });

  final Color backgroundColor;
  final Color borderColor;
  final Color textColor;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: backgroundColor,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
      ),
      child: SelectableText(
        text,
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: textColor,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _EmptyPane extends StatelessWidget {
  const _EmptyPane({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: _paneDecoration(),
      child: Center(
        child: SizedBox(width: 340, child: _EmptyNoteCard(message: message)),
      ),
    );
  }
}

class _EmptyPanelBody extends StatelessWidget {
  const _EmptyPanelBody({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SizedBox(width: 340, child: _EmptyNoteCard(message: message)),
    );
  }
}

class _EmptyNoteCard extends StatelessWidget {
  const _EmptyNoteCard({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0x73B59263)),
      ),
      child: Text(
        message,
        style: Theme.of(
          context,
        ).textTheme.bodyMedium?.copyWith(color: _WebColors.muted, height: 1.6),
        textAlign: TextAlign.center,
      ),
    );
  }
}

String? _keyEventToTerminalData(KeyEvent event) {
  final LogicalKeyboardKey key = event.logicalKey;
  final HardwareKeyboard keyboard = HardwareKeyboard.instance;

  if (key == LogicalKeyboardKey.enter ||
      key == LogicalKeyboardKey.numpadEnter) {
    return '\r';
  }
  if (key == LogicalKeyboardKey.backspace) {
    return '\u007f';
  }
  if (key == LogicalKeyboardKey.tab) {
    return '\t';
  }
  if (key == LogicalKeyboardKey.escape) {
    return '\u001b';
  }
  if (key == LogicalKeyboardKey.arrowUp) {
    return '\u001b[A';
  }
  if (key == LogicalKeyboardKey.arrowDown) {
    return '\u001b[B';
  }
  if (key == LogicalKeyboardKey.arrowRight) {
    return '\u001b[C';
  }
  if (key == LogicalKeyboardKey.arrowLeft) {
    return '\u001b[D';
  }
  if (key == LogicalKeyboardKey.delete) {
    return '\u001b[3~';
  }
  if (key == LogicalKeyboardKey.home) {
    return '\u001b[H';
  }
  if (key == LogicalKeyboardKey.end) {
    return '\u001b[F';
  }
  if (key == LogicalKeyboardKey.pageUp) {
    return '\u001b[5~';
  }
  if (key == LogicalKeyboardKey.pageDown) {
    return '\u001b[6~';
  }

  final String? character = event.character;
  if (character == null || character.isEmpty) {
    return null;
  }

  String output = character;
  if (keyboard.isControlPressed) {
    final int codeUnit = character.toUpperCase().codeUnitAt(0);
    if (codeUnit >= 64 && codeUnit <= 95) {
      output = String.fromCharCode(codeUnit - 64);
    }
  }
  if (keyboard.isAltPressed) {
    output = '\u001b$output';
  }
  return output;
}

String _summarizeCli({required SessionDetail? detail}) {
  if (detail == null) {
    return '—';
  }
  final String raw = _firstNonEmpty(<String>[
    detail.containerAgentPromptCommand,
    detail.agentPromptCommandOverride,
    detail.inferredAgentPromptCommand,
    detail.agentPromptCommand,
    detail.agentProgram,
  ]).trim();
  if (raw.isEmpty || raw == '—') {
    return '—';
  }
  final String first = raw.split(RegExp(r'\s+')).first.trim();
  return first.isEmpty ? raw : first;
}

String _inferTemplateCliValue(String raw) {
  final String text = raw.trim();
  if (text.isEmpty) {
    return '';
  }
  if (text.contains('claude')) {
    return 'claude';
  }
  if (text.contains('codex')) {
    return 'codex';
  }
  if (text.contains('gemini')) {
    return 'gemini';
  }
  if (text.contains('opencode')) {
    return 'opencode';
  }
  return '';
}

String _templateForCli(String cli) {
  return switch (cli) {
    'claude' => 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}',
    'codex' => 'codex exec --skip-git-repo-check {prompt}',
    'gemini' => 'gemini -p {prompt}',
    'opencode' => 'opencode run {prompt}',
    _ => '',
  };
}

String _formatFileNodeMeta(FileNode entry) {
  final String kind = entry.kind == 'directory'
      ? 'dir'
      : _formatFileSize(entry.size);
  final String time = _formatMtimeMs(entry.mtimeMs);
  return time.isEmpty ? kind : '$kind\n$time';
}

String _formatFileSize(int size) {
  if (size < 1024) {
    return '$size B';
  }
  if (size < 1024 * 1024) {
    return '${(size / 1024).toStringAsFixed(size >= 10 * 1024 ? 0 : 1)} KB';
  }
  return '${(size / (1024 * 1024)).toStringAsFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB';
}

String _formatMtimeMs(int mtimeMs) {
  if (mtimeMs <= 0) {
    return '';
  }
  final DateTime dt = DateTime.fromMillisecondsSinceEpoch(mtimeMs);
  final String mm = dt.month.toString().padLeft(2, '0');
  final String dd = dt.day.toString().padLeft(2, '0');
  final String hh = dt.hour.toString().padLeft(2, '0');
  final String mi = dt.minute.toString().padLeft(2, '0');
  return '$mm-$dd $hh:$mi';
}

String _firstNonEmpty(List<String> values) {
  for (final String value in values) {
    if (value.trim().isNotEmpty) {
      return value;
    }
  }
  return '—';
}
