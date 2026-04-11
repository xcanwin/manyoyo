import 'dart:io';

import 'package:flutter/material.dart';
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
  static const _serverUrlKey = 'manyoyo_server_url';

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
    true => '地址已可访问，可以直接从系统浏览器进入 MANYOYO。',
    false => '最近一次检测失败，请先确认 MANYOYO 服务是否启动并允许当前设备访问。',
    null when _hasConfiguredUrl => '地址已填写，建议先检测连接，再决定是否直接打开 MANYOYO。',
    null => '先填入 MANYOYO 地址，再保存、检测连接并打开入口。',
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

  Future<void> _openManyoyo() async {
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
                    constraints: const BoxConstraints(maxWidth: 760),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.92),
                        borderRadius: BorderRadius.circular(28),
                        border: Border.all(
                          color: colorScheme.primary.withValues(alpha: 0.22),
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: const Color(0x330F2A22),
                            blurRadius: 32,
                            offset: const Offset(0, 18),
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
                              'Flutter 客户端骨架已就绪',
                              style: textTheme.headlineMedium?.copyWith(
                                fontWeight: FontWeight.w700,
                                color: const Color(0xFF13201A),
                              ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              '当前工程已创建 macOS、Windows、iOS、Android 平台目录。下一步建议接入 MANYOYO Web 或服务端入口，而不是继续保留默认 Demo。',
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
                                    width: 420,
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
                                      FilledButton.tonal(
                                        onPressed: _loading
                                            ? null
                                            : _openManyoyo,
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
                                      '确认服务已经启动，避免直接打开后才发现端口或权限问题。',
                                ),
                                _StepCard(
                                  index: '03',
                                  title: '进入 MANYOYO',
                                  body:
                                      '通过系统浏览器打开 MANYOYO，先验证完整链路是否通畅。',
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
                                '建议下一步：\n1. 设计 MANYOYO 登录态与错误页。\n2. 明确 Flutter 端后续是原生客户端，还是保留外部浏览器壳。\n3. 再补路由、状态管理和网络层。',
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
      width: 210,
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
