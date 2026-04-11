import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

const String _manyoyoServerUrl = String.fromEnvironment(
  'MANYOYO_SERVER_URL',
  defaultValue: '',
);

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

class _ManyoyoHomePageState extends State<ManyoyoHomePage> {
  static const String _serverUrlKey = 'manyoyo_server_url';

  final TextEditingController _urlController = TextEditingController();

  bool _loading = true;
  bool _saving = false;
  bool _checking = false;
  String? _statusMessage;
  bool? _reachable;

  @override
  void initState() {
    super.initState();
    _loadInitialUrl();
  }

  @override
  void dispose() {
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
        builder: (BuildContext context) => ManyoyoWebShellPage(
          initialUrl: uri.toString(),
        ),
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
                                        child: const Text(
                                          '在系统浏览器打开 MANYOYO',
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 12),
                                  Text(
                                    _statusMessage ??
                                        '运行时可通过 --dart-define=MANYOYO_SERVER_URL=https://your-manyoyo.example.com 提供默认地址。',
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
                                  body:
                                      '确认服务已经启动，避免进入内置 Web 客户端后才发现端口或权限问题。',
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
                              '本地示例：flutter run -d macos --dart-define=MANYOYO_SERVER_URL=http://127.0.0.1:3000',
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

class _ManyoyoWebShellPageState extends State<ManyoyoWebShellPage> {
  InAppWebViewController? _controller;
  double _progress = 0;
  String _currentUrl = '';
  String _pageTitle = 'MANYOYO';
  String _statusText = '正在连接 MANYOYO...';
  bool _canGoBack = false;
  bool _canGoForward = false;
  String? _lastError;

  InAppWebViewSettings get _webViewSettings => InAppWebViewSettings(
    isInspectable: true,
    mediaPlaybackRequiresUserGesture: false,
    allowsInlineMediaPlayback: true,
    javaScriptCanOpenWindowsAutomatically: true,
    useShouldOverrideUrlLoading: true,
    supportZoom: false,
  );

  Future<void> _syncNavigationState() async {
    final controller = _controller;
    if (controller == null) {
      return;
    }

    final canGoBack = await controller.canGoBack();
    final canGoForward = await controller.canGoForward();
    if (!mounted) {
      return;
    }

    setState(() {
      _canGoBack = canGoBack;
      _canGoForward = canGoForward;
    });
  }

  Future<void> _openCurrentUrlExternally() async {
    final uri = Uri.tryParse(_currentUrl);
    if (uri == null) {
      return;
    }
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  Future<void> _goHome() async {
    await _controller?.loadUrl(
      urlRequest: URLRequest(url: WebUri(widget.initialUrl)),
    );
  }

  Future<void> _reload() async {
    await _controller?.reload();
  }

  Future<NavigationActionPolicy> _handleNavigation(
    NavigationAction navigationAction,
  ) async {
    final requestUrl = navigationAction.request.url;
    final uri = requestUrl == null ? null : Uri.tryParse(requestUrl.toString());
    if (uri == null) {
      return NavigationActionPolicy.ALLOW;
    }

    if (['http', 'https', 'file', 'about', 'data', 'javascript'].contains(
      uri.scheme,
    )) {
      return NavigationActionPolicy.ALLOW;
    }

    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
      return NavigationActionPolicy.CANCEL;
    }

    return NavigationActionPolicy.ALLOW;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _pageTitle,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              _currentUrl.isEmpty ? widget.initialUrl : _currentUrl,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: const Color(0xFF4D5C56),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _canGoBack ? () => _controller?.goBack() : null,
            tooltip: '后退',
            icon: const Icon(Icons.arrow_back),
          ),
          IconButton(
            onPressed: _canGoForward ? () => _controller?.goForward() : null,
            tooltip: '前进',
            icon: const Icon(Icons.arrow_forward),
          ),
          IconButton(
            onPressed: _goHome,
            tooltip: '回到 MANYOYO 首页',
            icon: const Icon(Icons.home_outlined),
          ),
          IconButton(
            onPressed: _reload,
            tooltip: '刷新',
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            onPressed: _openCurrentUrlExternally,
            tooltip: '在系统浏览器打开',
            icon: const Icon(Icons.open_in_new),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(42),
          child: Column(
            children: [
              if (_progress < 1)
                LinearProgressIndicator(value: _progress)
              else
                const SizedBox(height: 4),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
                child: Text(
                  _lastError ?? _statusText,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: _lastError == null
                        ? const Color(0xFF4D5C56)
                        : const Color(0xFFB42318),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      body: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri(widget.initialUrl)),
        initialSettings: _webViewSettings,
        onWebViewCreated: (InAppWebViewController controller) {
          _controller = controller;
        },
        shouldOverrideUrlLoading: (
          InAppWebViewController controller,
          NavigationAction navigationAction,
        ) async {
          return _handleNavigation(navigationAction);
        },
        onLoadStart: (InAppWebViewController controller, WebUri? url) {
          setState(() {
            _currentUrl = url?.toString() ?? widget.initialUrl;
            _statusText = '正在加载 $_currentUrl';
            _lastError = null;
          });
          _syncNavigationState();
        },
        onTitleChanged: (
          InAppWebViewController controller,
          String? title,
        ) {
          if (!mounted || title == null || title.trim().isEmpty) {
            return;
          }
          setState(() {
            _pageTitle = title.trim();
          });
        },
        onLoadStop: (InAppWebViewController controller, WebUri? url) async {
          await _syncNavigationState();
          if (!mounted) {
            return;
          }
          setState(() {
            _currentUrl = url?.toString() ?? widget.initialUrl;
            _statusText = '已进入 MANYOYO Web 客户端';
            _lastError = null;
            _progress = 1;
          });
        },
        onProgressChanged: (
          InAppWebViewController controller,
          int progress,
        ) {
          if (!mounted) {
            return;
          }
          setState(() {
            _progress = progress / 100;
            if (_lastError == null) {
              _statusText = progress >= 100
                  ? '已进入 MANYOYO Web 客户端'
                  : '加载中 ${progress.toString()}%';
            }
          });
        },
        onUpdateVisitedHistory: (
          InAppWebViewController controller,
          WebUri? url,
          bool? isReload,
        ) {
          if (!mounted) {
            return;
          }
          setState(() {
            _currentUrl = url?.toString() ?? _currentUrl;
          });
          _syncNavigationState();
        },
        onReceivedError: (
          InAppWebViewController controller,
          WebResourceRequest request,
          WebResourceError error,
        ) {
          if (request.isForMainFrame != true) {
            return;
          }
          setState(() {
            _lastError = '页面加载失败：${error.description}';
            _progress = 1;
          });
        },
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
