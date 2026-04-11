import 'package:flutter/material.dart';
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

class ManyoyoHomePage extends StatelessWidget {
  const ManyoyoHomePage({super.key});

  Future<void> _openManyoyo() async {
    final trimmed = _manyoyoServerUrl.trim();
    if (trimmed.isEmpty) {
      return;
    }

    final uri = Uri.tryParse(trimmed);
    if (uri == null) {
      return;
    }

    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final hasServerUrl = _manyoyoServerUrl.trim().isNotEmpty;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Padding(
              padding: const EdgeInsets.all(24),
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
                          color: const Color(0xFFF7F3EC),
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(
                            color: colorScheme.primary.withValues(alpha: 0.16),
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
                            SelectableText(
                              hasServerUrl
                                  ? _manyoyoServerUrl
                                  : '未配置。运行时可通过 --dart-define=MANYOYO_SERVER_URL=https://your-manyoyo.example.com 指定。',
                              style: textTheme.bodyMedium?.copyWith(
                                height: 1.6,
                                color: const Color(0xFF42524B),
                              ),
                            ),
                            const SizedBox(height: 14),
                            FilledButton(
                              onPressed: hasServerUrl ? _openManyoyo : null,
                              child: const Text('在系统浏览器打开 MANYOYO'),
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
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(18),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF0F7F3),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          '建议下一步：\n1. 明确 Flutter 端是 WebView 壳，还是原生客户端。\n2. 统一登录、会话和容器访问边界。\n3. 再决定是否接入状态管理、路由和网络层。',
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
