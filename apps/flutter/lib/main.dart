import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart' hide Cookie;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:manyoyo_flutter/web_shell_navigation.dart';

const String _manyoyoServerUrl = String.fromEnvironment(
  'MANYOYO_SERVER_URL',
  defaultValue: '',
);
const String _desktopAutoServeEnv = 'MANYOYO_DESKTOP_AUTO_SERVE';
const String _desktopAutoServeListenEnv = 'MANYOYO_DESKTOP_AUTO_SERVE_LISTEN';
const String _desktopAutoServeRootEnv = 'MANYOYO_DESKTOP_AUTO_SERVE_ROOT';
const String _desktopAutoServeNodeEnv = 'MANYOYO_DESKTOP_AUTO_SERVE_NODE';
const String _defaultDesktopAutoServeListen = '127.0.0.1:3000';

bool _isTruthyEnv(String? value) {
  final normalized = (value ?? '').trim().toLowerCase();
  return normalized == '1' ||
      normalized == 'true' ||
      normalized == 'yes' ||
      normalized == 'on';
}

bool _supportsDesktopAutoServe() => Platform.isMacOS || Platform.isWindows;

String _randomToken([int length = 16]) {
  final random = Random.secure();
  final buffer = StringBuffer();
  for (var i = 0; i < length; i += 1) {
    buffer.write(random.nextInt(16).toRadixString(16));
  }
  return buffer.toString();
}

String? _findRepoRootFromDirectory(Directory? start) {
  if (start == null || start.path.trim().isEmpty) {
    return null;
  }
  final separator = Platform.pathSeparator;
  var current = start.absolute;
  while (true) {
    final binFile = File(
      '${current.path}${separator}bin${separator}manyoyo.js',
    );
    if (binFile.existsSync()) {
      return current.path;
    }
    final parent = current.parent;
    if (parent.path == current.path) {
      break;
    }
    current = parent;
  }
  return null;
}

String? _resolveDesktopAutoServeRepoRoot() {
  final envRoot = (Platform.environment[_desktopAutoServeRootEnv] ?? '').trim();
  if (envRoot.isNotEmpty) {
    return _findRepoRootFromDirectory(Directory(envRoot));
  }

  final candidates = <Directory>[
    Directory.current,
    File(Platform.resolvedExecutable).parent,
  ];

  final pwd = (Platform.environment['PWD'] ?? '').trim();
  if (pwd.isNotEmpty) {
    candidates.add(Directory(pwd));
  }

  for (final candidate in candidates) {
    final repoRoot = _findRepoRootFromDirectory(candidate);
    if (repoRoot != null) {
      return repoRoot;
    }
  }
  return null;
}

void main() {
  runApp(const ManyoyoApp());
}

class ManyoyoApp extends StatelessWidget {
  const ManyoyoApp({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xFF0B6E4F),
        brightness: Brightness.light,
      ),
      scaffoldBackgroundColor: const Color(0xFFF4EFE6),
      useMaterial3: true,
    );

    return MaterialApp(
      title: 'MANYOYO Flutter',
      debugShowCheckedModeBanner: false,
      theme: theme,
      home: const ManyoyoHomePage(),
    );
  }
}

class ManyoyoHomePage extends StatefulWidget {
  const ManyoyoHomePage({super.key});

  @override
  State<ManyoyoHomePage> createState() => _ManyoyoHomePageState();
}

class _ManyoyoHomePageState extends State<ManyoyoHomePage>
    with WidgetsBindingObserver {
  static const String _serverUrlKey = 'manyoyo_server_url';

  final TextEditingController _urlController = TextEditingController();
  StringBuffer _desktopServerLog = StringBuffer();

  bool _loading = true;
  bool _saving = false;
  bool _checking = false;
  String? _statusMessage;
  bool? _reachable;
  Process? _desktopServerProcess;
  StreamSubscription<String>? _desktopServerStdoutSub;
  StreamSubscription<String>? _desktopServerStderrSub;
  bool _desktopAutoServeOpened = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (_shouldAutoServeOnDesktop()) {
      _startDesktopAutoServe();
      return;
    }
    _loadInitialUrl();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _desktopServerStdoutSub?.cancel();
    _desktopServerStderrSub?.cancel();
    _desktopServerProcess?.kill();
    _urlController.dispose();
    super.dispose();
  }

  SharedPreferencesAsync? _createPreferences() {
    try {
      return SharedPreferencesAsync();
    } on StateError {
      return null;
    }
  }

  Future<void> _loadInitialUrl() async {
    final preferences = _createPreferences();
    final savedUrl = preferences == null
        ? null
        : await preferences.getString(_serverUrlKey);
    final initialUrl = (savedUrl ?? '').trim().isNotEmpty
        ? savedUrl!.trim()
        : _manyoyoServerUrl.trim();

    if (!mounted) {
      return;
    }

    setState(() {
      _urlController.text = initialUrl;
      _loading = false;
    });
  }

  bool _shouldAutoServeOnDesktop() {
    return _supportsDesktopAutoServe() &&
        _isTruthyEnv(Platform.environment[_desktopAutoServeEnv]);
  }

  void _appendDesktopServerLog(String chunk) {
    if (chunk.isEmpty) {
      return;
    }
    final current = _desktopServerLog.toString();
    if (current.length > 8000) {
      final trimmed = current.substring(current.length - 4000);
      _desktopServerLog = StringBuffer(trimmed);
    }
    _desktopServerLog.write(chunk);
  }

  String _desktopServerLogText() {
    return _desktopServerLog.toString().trim();
  }

  Future<void> _startDesktopAutoServe() async {
    final repoRoot = _resolveDesktopAutoServeRepoRoot();
    if (repoRoot == null) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _reachable = false;
        _statusMessage =
            '未找到 manyoyo 仓库根目录。可设置 MANYOYO_DESKTOP_AUTO_SERVE_ROOT=/abs/path 后再重试。';
      });
      return;
    }

    final listen =
        (Platform.environment[_desktopAutoServeListenEnv] ?? '').trim().isEmpty
        ? _defaultDesktopAutoServeListen
        : (Platform.environment[_desktopAutoServeListenEnv] ?? '').trim();
    final nodeBin =
        (Platform.environment[_desktopAutoServeNodeEnv] ?? '').trim().isEmpty
        ? 'node'
        : (Platform.environment[_desktopAutoServeNodeEnv] ?? '').trim();
    final authUser = 'manyoyo_flutter_${_randomToken(8)}';
    final authPass = _randomToken(24);
    final baseUrl = 'http://$listen';
    final binPath =
        '$repoRoot${Platform.pathSeparator}bin${Platform.pathSeparator}manyoyo.js';

    if (mounted) {
      setState(() {
        _statusMessage = '正在启动本地 MANYOYO 服务...';
        _reachable = null;
      });
    }

    try {
      final process = await Process.start(
        nodeBin,
        <String>[binPath, 'serve', listen, '-U', authUser, '-P', authPass],
        workingDirectory: repoRoot,
        includeParentEnvironment: true,
      );
      _desktopServerProcess = process;
      _desktopServerStdoutSub = process.stdout
          .transform(utf8.decoder)
          .listen(_appendDesktopServerLog);
      _desktopServerStderrSub = process.stderr
          .transform(utf8.decoder)
          .listen(_appendDesktopServerLog);

      await _waitForDesktopServerReady(process, Uri.parse(baseUrl));
      await _installDesktopAutoServeCookie(
        Uri.parse(baseUrl),
        authUser,
        authPass,
      );

      if (!mounted) {
        return;
      }

      setState(() {
        _urlController.text = baseUrl;
        _loading = false;
        _reachable = true;
        _statusMessage = '本地 MANYOYO 服务已启动，正在进入内置客户端。';
      });

      if (!_desktopAutoServeOpened) {
        _desktopAutoServeOpened = true;
        await _openManyoyoInternally();
      }
    } catch (error) {
      _desktopServerProcess?.kill();
      _desktopServerProcess = null;

      if (!mounted) {
        return;
      }

      final logText = _desktopServerLogText();
      setState(() {
        _loading = false;
        _reachable = false;
        _statusMessage = logText.isEmpty
            ? '桌面端自动启动 MANYOYO 服务失败：$error'
            : '桌面端自动启动 MANYOYO 服务失败：$error\n\n$logText';
      });
    }
  }

  Future<void> _waitForDesktopServerReady(Process process, Uri baseUri) async {
    final deadline = DateTime.now().add(const Duration(seconds: 25));
    while (DateTime.now().isBefore(deadline)) {
      if (await _isProcessExited(process)) {
        final logText = _desktopServerLogText();
        throw StateError(logText.isEmpty ? 'manyoyo serve 已提前退出。' : logText);
      }

      final reachable = await _probeManyoyo(baseUri);
      if (reachable) {
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    throw StateError('等待 MANYOYO 服务启动超时。');
  }

  Future<bool> _isProcessExited(Process process) async {
    final exitCodeFuture = process.exitCode.then((_) => true);
    final timeoutFuture = Future<bool>.delayed(
      const Duration(milliseconds: 10),
      () => false,
    );
    return Future.any<bool>(<Future<bool>>[exitCodeFuture, timeoutFuture]);
  }

  Future<bool> _probeManyoyo(Uri uri) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
    try {
      final request = await client.getUrl(uri);
      request.followRedirects = false;
      final response = await request.close().timeout(
        const Duration(seconds: 2),
      );
      await response.drain<void>();
      return response.statusCode >= 200 && response.statusCode < 500;
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  Future<void> _installDesktopAutoServeCookie(
    Uri baseUri,
    String authUser,
    String authPass,
  ) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final request = await client.postUrl(
        baseUri.replace(path: '/auth/login'),
      );
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.write(
        jsonEncode(<String, String>{
          'username': authUser,
          'password': authPass,
        }),
      );
      final response = await request.close().timeout(
        const Duration(seconds: 5),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final body = await utf8.decoder.bind(response).join();
        throw StateError(body.isEmpty ? '自动登录失败。' : body);
      }

      Cookie? cookie;
      for (final item in response.cookies) {
        if (item.name == 'manyoyo_web_auth') {
          cookie = item;
          break;
        }
      }
      await response.drain<void>();
      if (cookie == null) {
        throw StateError('未获取到 manyoyo_web_auth Cookie。');
      }

      final cookieManager = CookieManager.instance();
      await cookieManager.setCookie(
        url: WebUri(baseUri.toString()),
        name: cookie.name,
        value: cookie.value,
        path: (cookie.path?.isNotEmpty ?? false) ? cookie.path! : '/',
        isHttpOnly: cookie.httpOnly,
        isSecure: cookie.secure,
      );
    } finally {
      client.close(force: true);
    }
  }

  String get _currentUrl => _urlController.text.trim();

  bool get _hasConfiguredUrl => _currentUrl.isNotEmpty;

  String get _connectionStageLabel => switch (_reachable) {
    true => '服务在线',
    false => '等待修复',
    null when _hasConfiguredUrl => '等待检测',
    null => '尚未配置',
  };

  String get _connectionSummary => switch (_reachable) {
    true => '地址已可访问，可以直接进入内置 MANYOYO Web 客户端。',
    false => '最近一次检测失败，请先确认 MANYOYO 服务已启动并允许当前设备访问。',
    null when _hasConfiguredUrl => '地址已填写，建议先检测连接，再进入内置 MANYOYO。',
    null => '先填入 MANYOYO 地址，再保存、检测连接并进入 Web 客户端。',
  };

  Color get _connectionBadgeColor => switch (_reachable) {
    true => const Color(0xFFD7F4E7),
    false => const Color(0xFFFDE2E0),
    null => const Color(0xFFE8F0EC),
  };

  Uri? _parseUrl(String value) {
    final uri = Uri.tryParse(value.trim());
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      return null;
    }
    return uri;
  }

  Future<void> _saveUrl() async {
    final value = _currentUrl;
    setState(() {
      _saving = true;
      _statusMessage = null;
    });

    try {
      final preferences = _createPreferences();
      if (preferences == null) {
        if (!mounted) {
          return;
        }

        setState(() {
          _statusMessage = '当前环境不支持本地保存，请直接使用当前输入地址。';
          _reachable = null;
        });
        return;
      }

      if (value.isEmpty) {
        await preferences.remove(_serverUrlKey);
      } else {
        await preferences.setString(_serverUrlKey, value);
      }

      if (!mounted) {
        return;
      }

      setState(() {
        _statusMessage = value.isEmpty
            ? '已清空本地 MANYOYO 地址。'
            : '已保存 MANYOYO 地址。';
        _reachable = null;
      });
    } finally {
      if (mounted) {
        setState(() {
          _saving = false;
        });
      }
    }
  }

  Future<void> _openManyoyoExternally() async {
    final uri = _parseUrl(_currentUrl);
    if (uri == null) {
      setState(() {
        _statusMessage = '请输入合法的 MANYOYO 地址，例如 http://127.0.0.1:3000';
        _reachable = false;
      });
      return;
    }

    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!launched && mounted) {
      setState(() {
        _statusMessage = '无法打开系统浏览器，请检查当前设备配置。';
        _reachable = false;
      });
    }
  }

  Future<void> _openManyoyoInternally() async {
    final uri = _parseUrl(_currentUrl);
    if (uri == null) {
      setState(() {
        _statusMessage = '请输入合法的 MANYOYO 地址，例如 http://127.0.0.1:3000';
        _reachable = false;
      });
      return;
    }

    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (BuildContext context) =>
            ManyoyoWebShellPage(initialUrl: uri.toString()),
      ),
    );
  }

  Future<void> _checkConnection() async {
    final uri = _parseUrl(_currentUrl);
    if (uri == null) {
      setState(() {
        _statusMessage = '请输入合法的 MANYOYO 地址，例如 http://127.0.0.1:3000';
        _reachable = false;
      });
      return;
    }

    setState(() {
      _checking = true;
      _statusMessage = '正在检测连接...';
      _reachable = null;
    });

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final request = await client.getUrl(uri);
      request.followRedirects = false;
      final response = await request.close().timeout(
        const Duration(seconds: 5),
      );
      final statusCode = response.statusCode;
      final reachable = statusCode >= 200 && statusCode < 500;
      await response.drain<void>();

      if (!mounted) {
        return;
      }

      setState(() {
        _reachable = reachable;
        _statusMessage = reachable
            ? '连接成功，服务已响应（HTTP $statusCode）。'
            : '服务不可用，返回 HTTP $statusCode。';
      });
    } catch (error) {
      if (!mounted) {
        return;
      }

      setState(() {
        _reachable = false;
        _statusMessage = '连接失败：${error.toString()}';
      });
    } finally {
      client.close(force: true);
      if (mounted) {
        setState(() {
          _checking = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final statusColor = switch (_reachable) {
      true => const Color(0xFF0B6E4F),
      false => const Color(0xFFB42318),
      null => const Color(0xFF5A6B64),
    };

    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            return SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: constraints.maxHeight - 48,
                ),
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 820),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.92),
                        borderRadius: BorderRadius.circular(28),
                        border: Border.all(
                          color: colorScheme.primary.withValues(alpha: 0.22),
                        ),
                        boxShadow: const [
                          BoxShadow(
                            color: Color(0x330F2A22),
                            blurRadius: 32,
                            offset: Offset(0, 18),
                          ),
                        ],
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(28, 30, 28, 28),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 6,
                              ),
                              decoration: BoxDecoration(
                                color: colorScheme.primaryContainer,
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                'MANYOYO FLUTTER',
                                style: textTheme.labelSmall?.copyWith(
                                  letterSpacing: 1.4,
                                  fontWeight: FontWeight.w700,
                                  color: colorScheme.primary,
                                ),
                              ),
                            ),
                            const SizedBox(height: 18),
                            Text(
                              'Flutter Web 客户端已接管正式入口',
                              style: textTheme.headlineMedium?.copyWith(
                                fontWeight: FontWeight.w700,
                                color: const Color(0xFF13201A),
                              ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              '目标是不重写 main 分支现有 Web 前端，而是在 Flutter 中内嵌 MANYOYO Web 界面，让登录页、主界面、会话流、文件与终端等功能整体复用。',
                              style: textTheme.bodyLarge?.copyWith(
                                height: 1.6,
                                color: const Color(0xFF4D5C56),
                              ),
                            ),
                            const SizedBox(height: 24),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.all(18),
                              decoration: BoxDecoration(
                                gradient: const LinearGradient(
                                  colors: [
                                    Color(0xFFF3F8F5),
                                    Color(0xFFE8F1EC),
                                  ],
                                  begin: Alignment.topLeft,
                                  end: Alignment.bottomRight,
                                ),
                                borderRadius: BorderRadius.circular(22),
                                border: Border.all(
                                  color: colorScheme.primary.withValues(
                                    alpha: 0.12,
                                  ),
                                ),
                              ),
                              child: Wrap(
                                spacing: 16,
                                runSpacing: 16,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 12,
                                      vertical: 8,
                                    ),
                                    decoration: BoxDecoration(
                                      color: _connectionBadgeColor,
                                      borderRadius: BorderRadius.circular(999),
                                    ),
                                    child: Text(
                                      _connectionStageLabel,
                                      style: textTheme.labelLarge?.copyWith(
                                        color: const Color(0xFF173429),
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                  ),
                                  SizedBox(
                                    width: 460,
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Text(
                                          '启动页',
                                          style: textTheme.titleMedium
                                              ?.copyWith(
                                                fontWeight: FontWeight.w700,
                                                color: const Color(0xFF13201A),
                                              ),
                                        ),
                                        const SizedBox(height: 6),
                                        Text(
                                          _connectionSummary,
                                          style: textTheme.bodyMedium?.copyWith(
                                            height: 1.6,
                                            color: const Color(0xFF42524B),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 18),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.all(18),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF7F3EC),
                                borderRadius: BorderRadius.circular(20),
                                border: Border.all(
                                  color: colorScheme.primary.withValues(
                                    alpha: 0.16,
                                  ),
                                ),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    '当前 MANYOYO 地址',
                                    style: textTheme.labelLarge?.copyWith(
                                      fontWeight: FontWeight.w700,
                                      color: const Color(0xFF284238),
                                    ),
                                  ),
                                  const SizedBox(height: 10),
                                  TextField(
                                    controller: _urlController,
                                    enabled: !_loading,
                                    decoration: const InputDecoration(
                                      hintText: 'http://127.0.0.1:3000',
                                      border: OutlineInputBorder(),
                                    ),
                                    keyboardType: TextInputType.url,
                                  ),
                                  const SizedBox(height: 14),
                                  Wrap(
                                    spacing: 12,
                                    runSpacing: 12,
                                    children: [
                                      OutlinedButton(
                                        onPressed: _loading
                                            ? null
                                            : () {
                                                _urlController.text =
                                                    'http://127.0.0.1:3000';
                                                setState(() {
                                                  _statusMessage =
                                                      '已填入本机默认地址，可直接保存或检测连接。';
                                                  _reachable = null;
                                                });
                                              },
                                        child: const Text('填入本机地址'),
                                      ),
                                      FilledButton(
                                        onPressed: _loading || _saving
                                            ? null
                                            : _saveUrl,
                                        child: Text(
                                          _saving ? '保存中...' : '保存地址',
                                        ),
                                      ),
                                      OutlinedButton(
                                        onPressed: _loading || _checking
                                            ? null
                                            : _checkConnection,
                                        child: Text(
                                          _checking ? '检测中...' : '检测连接',
                                        ),
                                      ),
                                      FilledButton(
                                        onPressed: _loading
                                            ? null
                                            : _openManyoyoInternally,
                                        child: const Text('进入内置 MANYOYO'),
                                      ),
                                      FilledButton.tonal(
                                        onPressed: _loading
                                            ? null
                                            : _openManyoyoExternally,
                                        child: const Text('在系统浏览器打开 MANYOYO'),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 12),
                                  Text(
                                    _statusMessage ??
                                        '运行时可通过 --dart-define=MANYOYO_SERVER_URL=https://your-manyoyo.example.com 提供默认地址；桌面端也可通过 MANYOYO_DESKTOP_AUTO_SERVE=1 自动拉起本地服务。',
                                    style: textTheme.bodyMedium?.copyWith(
                                      height: 1.6,
                                      color: statusColor,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 24),
                            Wrap(
                              spacing: 12,
                              runSpacing: 12,
                              children: const [
                                _PlatformChip(label: 'macOS'),
                                _PlatformChip(label: 'Windows'),
                                _PlatformChip(label: 'iOS'),
                                _PlatformChip(label: 'Android'),
                              ],
                            ),
                            const SizedBox(height: 28),
                            Text(
                              '推荐流程',
                              style: textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.w700,
                                color: const Color(0xFF13201A),
                              ),
                            ),
                            const SizedBox(height: 12),
                            const Wrap(
                              spacing: 14,
                              runSpacing: 14,
                              children: [
                                _StepCard(
                                  index: '01',
                                  title: '配置地址',
                                  body: '填写 MANYOYO 服务地址，可用本机默认地址快速开始。',
                                ),
                                _StepCard(
                                  index: '02',
                                  title: '检测连接',
                                  body: '确认服务已经启动，避免进入内置 Web 客户端后才发现端口或权限问题。',
                                ),
                                _StepCard(
                                  index: '03',
                                  title: '进入 MANYOYO',
                                  body:
                                      '直接进入内置 MANYOYO Web 壳，复用 main 分支已有登录页与主界面。',
                                ),
                              ],
                            ),
                            const SizedBox(height: 28),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.all(18),
                              decoration: BoxDecoration(
                                color: const Color(0xFFF0F7F3),
                                borderRadius: BorderRadius.circular(20),
                              ),
                              child: Text(
                                '当前方向：Flutter 负责宿主壳、地址管理和原生入口；MANYOYO 的核心业务界面继续复用 main 分支现有 Web 实现。',
                                style: textTheme.bodyMedium?.copyWith(
                                  height: 1.7,
                                  color: const Color(0xFF284238),
                                ),
                              ),
                            ),
                            const SizedBox(height: 16),
                            Text(
                              '本地示例：flutter run -d macos --dart-define=MANYOYO_SERVER_URL=http://127.0.0.1:3000\n桌面联动示例：MANYOYO_DESKTOP_AUTO_SERVE=1 flutter run -d macos',
                              style: textTheme.bodySmall?.copyWith(
                                color: const Color(0xFF5A6B64),
                                height: 1.6,
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
          },
        ),
      ),
    );
  }
}

class ManyoyoWebShellPage extends StatefulWidget {
  const ManyoyoWebShellPage({super.key, required this.initialUrl});

  final String initialUrl;

  @override
  State<ManyoyoWebShellPage> createState() => _ManyoyoWebShellPageState();
}

String _buildManyoyoHostSafeAreaScript(EdgeInsets viewPadding) {
  const hostSafeAreaStyle = '''
@media (max-width: 980px) {
  :root.manyoyo-host-safe-area .header {
    padding-top: calc(6px + var(--manyoyo-host-safe-top) + 12px) !important;
  }

  :root.manyoyo-host-safe-area .sidebar {
    padding-top: calc(16px + var(--manyoyo-host-safe-top) + 12px) !important;
    padding-right: calc(16px + var(--manyoyo-host-safe-right)) !important;
    padding-bottom: calc(16px + var(--manyoyo-host-safe-bottom)) !important;
    padding-left: calc(16px + var(--manyoyo-host-safe-left)) !important;
  }
}

@media (max-width: 640px) {
  :root.manyoyo-host-safe-area .header {
    padding: calc(10px + var(--manyoyo-host-safe-top) + 12px) 12px 16px !important;
  }
}
''';
  final top = '${viewPadding.top.toStringAsFixed(2)}px';
  final right = '${viewPadding.right.toStringAsFixed(2)}px';
  final bottom = '${viewPadding.bottom.toStringAsFixed(2)}px';
  final left = '${viewPadding.left.toStringAsFixed(2)}px';
  final styleJson = jsonEncode(hostSafeAreaStyle);
  return '''
(() => {
  const root = document.documentElement;
  if (!root) {
    return;
  }
  root.classList.add('manyoyo-host-safe-area');
  root.style.setProperty('--manyoyo-host-safe-top', ${jsonEncode(top)});
  root.style.setProperty('--manyoyo-host-safe-right', ${jsonEncode(right)});
  root.style.setProperty('--manyoyo-host-safe-bottom', ${jsonEncode(bottom)});
  root.style.setProperty('--manyoyo-host-safe-left', ${jsonEncode(left)});
  const styleId = 'manyoyo-host-safe-area-style';
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = $styleJson;
})();
''';
}

class _ManyoyoWebShellPageState extends State<ManyoyoWebShellPage>
    with WidgetsBindingObserver {
  InAppWebViewController? _controller;
  String? _lastError;
  late final Uri? _shellBaseUri;
  String? _lastInjectedSafeAreaKey;

  InAppWebViewSettings get _webViewSettings => InAppWebViewSettings(
    isInspectable: true,
    mediaPlaybackRequiresUserGesture: false,
    allowsInlineMediaPlayback: true,
    javaScriptCanOpenWindowsAutomatically: true,
    useShouldOverrideUrlLoading: true,
    supportMultipleWindows: true,
    supportZoom: false,
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _shellBaseUri = Uri.tryParse(widget.initialUrl);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_injectHostSafeAreaStyling(force: true));
    });
  }

  @override
  void didChangeMetrics() {
    unawaited(_injectHostSafeAreaStyling(force: true));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _injectHostSafeAreaStyling({bool force = false}) async {
    final controller = _controller;
    if (!mounted || controller == null) {
      return;
    }

    final viewPadding = MediaQuery.viewPaddingOf(context);
    final cacheKey =
        '${viewPadding.top.toStringAsFixed(2)}|'
        '${viewPadding.right.toStringAsFixed(2)}|'
        '${viewPadding.bottom.toStringAsFixed(2)}|'
        '${viewPadding.left.toStringAsFixed(2)}';
    if (!force && cacheKey == _lastInjectedSafeAreaKey) {
      return;
    }

    try {
      await controller.evaluateJavascript(
        source: _buildManyoyoHostSafeAreaScript(viewPadding),
      );
      _lastInjectedSafeAreaKey = cacheKey;
    } catch (_) {
      // Ignore transient injection failures while the page is navigating.
    }
  }

  Future<NavigationActionPolicy> _handleNavigation(
    NavigationAction navigationAction,
  ) async {
    final uri = parseWebUri(navigationAction.request.url);
    if (shouldAllowInAppNavigation(uri, shellBaseUri: _shellBaseUri)) {
      return NavigationActionPolicy.ALLOW;
    }

    if (uri != null && await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
      return NavigationActionPolicy.CANCEL;
    }

    return NavigationActionPolicy.ALLOW;
  }

  Future<bool> _handleCreateWindow(
    CreateWindowAction createWindowAction,
  ) async {
    final uri = parseWebUri(createWindowAction.request.url);
    if (shouldAllowInAppNavigation(uri, shellBaseUri: _shellBaseUri)) {
      if (uri != null) {
        await _controller?.loadUrl(
          urlRequest: URLRequest(url: WebUri(uri.toString())),
        );
      }
      return false;
    }

    if (!shouldOpenExternalWindow(uri, shellBaseUri: _shellBaseUri)) {
      return false;
    }

    if (uri != null && await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: InAppWebView(
              initialUrlRequest: URLRequest(url: WebUri(widget.initialUrl)),
              initialSettings: _webViewSettings,
              onWebViewCreated: (InAppWebViewController controller) {
                _controller = controller;
                unawaited(_injectHostSafeAreaStyling(force: true));
              },
              shouldOverrideUrlLoading:
                  (
                    InAppWebViewController controller,
                    NavigationAction navigationAction,
                  ) async {
                    return _handleNavigation(navigationAction);
                  },
              onCreateWindow:
                  (
                    InAppWebViewController controller,
                    CreateWindowAction createWindowAction,
                  ) async {
                    return _handleCreateWindow(createWindowAction);
                  },
              onLoadStart: (InAppWebViewController controller, WebUri? url) {
                if (!mounted) {
                  return;
                }
                setState(() {
                  _lastError = null;
                });
              },
              onLoadStop:
                  (InAppWebViewController controller, WebUri? url) async {
                    if (!mounted) {
                      return;
                    }
                    setState(() {
                      _lastError = null;
                    });
                    await _injectHostSafeAreaStyling(force: true);
                  },
              onReceivedError:
                  (
                    InAppWebViewController controller,
                    WebResourceRequest request,
                    WebResourceError error,
                  ) {
                    if (request.isForMainFrame != true) {
                      return;
                    }
                    setState(() {
                      _lastError = '页面加载失败：${error.description}';
                    });
                  },
            ),
          ),
          if (_lastError != null)
            Positioned(
              left: 16,
              right: 16,
              bottom: 16,
              child: Material(
                color: Colors.transparent,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: const Color(0xFFFDE2E0),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    child: Text(
                      _lastError!,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: const Color(0xFFB42318),
                        fontWeight: FontWeight.w600,
                      ),
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

class _PlatformChip extends StatelessWidget {
  const _PlatformChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xFF13201A),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelLarge?.copyWith(
            color: Colors.white,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _StepCard extends StatelessWidget {
  const _StepCard({
    required this.index,
    required this.title,
    required this.body,
  });

  final String index;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 220,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: const Color(0xFFF7F3EC),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xFFE0D7C8)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                index,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: const Color(0xFF0B6E4F),
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.2,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                title,
                style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: const Color(0xFF13201A),
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                body,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  height: 1.6,
                  color: const Color(0xFF4D5C56),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
