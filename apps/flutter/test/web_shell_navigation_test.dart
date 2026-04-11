import 'package:flutter_test/flutter_test.dart';
import 'package:manyoyo_flutter/web_shell_navigation.dart';

void main() {
  test('allows standard web navigation inside manyoyo shell', () {
    expect(shouldAllowInAppNavigation(Uri.parse('https://manyoyo.example.com')), isTrue);
    expect(shouldAllowInAppNavigation(Uri.parse('http://127.0.0.1:3000')), isTrue);
    expect(shouldAllowInAppNavigation(Uri.parse('file:///tmp/demo.html')), isTrue);
    expect(shouldAllowInAppNavigation(Uri.parse('about:blank')), isTrue);
  });

  test('marks new-window links for external browser handling', () {
    expect(shouldOpenExternalWindow(Uri.parse('https://manyoyo.example.com/docs')), isTrue);
    expect(shouldOpenExternalWindow(Uri.parse('mailto:support@example.com')), isTrue);
    expect(shouldOpenExternalWindow(Uri.parse('about:blank')), isFalse);
    expect(shouldOpenExternalWindow(Uri.parse('javascript:void(0)')), isFalse);
    expect(shouldOpenExternalWindow(null), isFalse);
  });
}
