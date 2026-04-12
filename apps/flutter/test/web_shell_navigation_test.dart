import 'package:flutter_test/flutter_test.dart';
import 'package:manyoyo_flutter/web_shell_navigation.dart';

void main() {
  test('allows same-origin navigation inside manyoyo shell', () {
    final shellBaseUri = Uri.parse('http://127.0.0.1:3000');

    expect(
      shouldAllowInAppNavigation(
        Uri.parse('http://127.0.0.1:3000/app'),
        shellBaseUri: shellBaseUri,
      ),
      isTrue,
    );
    expect(
      shouldAllowInAppNavigation(
        Uri.parse('http://127.0.0.1:3000/docs?a=1'),
        shellBaseUri: shellBaseUri,
      ),
      isTrue,
    );
    expect(
      shouldAllowInAppNavigation(
        Uri.parse('https://manyoyo.example.com'),
        shellBaseUri: shellBaseUri,
      ),
      isFalse,
    );
    expect(
      shouldAllowInAppNavigation(Uri.parse('file:///tmp/demo.html')),
      isTrue,
    );
    expect(shouldAllowInAppNavigation(Uri.parse('about:blank')), isTrue);
  });

  test(
    'marks cross-origin and custom-scheme links for external browser handling',
    () {
      final shellBaseUri = Uri.parse('http://127.0.0.1:3000');

      expect(
        shouldOpenExternalWindow(
          Uri.parse('https://manyoyo.example.com/docs'),
          shellBaseUri: shellBaseUri,
        ),
        isTrue,
      );
      expect(
        shouldOpenExternalWindow(
          Uri.parse('http://127.0.0.1:3000/docs'),
          shellBaseUri: shellBaseUri,
        ),
        isFalse,
      );
      expect(
        shouldOpenExternalWindow(Uri.parse('mailto:support@example.com')),
        isTrue,
      );
      expect(shouldOpenExternalWindow(Uri.parse('about:blank')), isFalse);
      expect(
        shouldOpenExternalWindow(Uri.parse('javascript:void(0)')),
        isFalse,
      );
      expect(shouldOpenExternalWindow(null), isFalse);
    },
  );
}
