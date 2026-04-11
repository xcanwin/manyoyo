import 'package:flutter_inappwebview/flutter_inappwebview.dart';

const Set<String> _inAppSchemes = <String>{
  'http',
  'https',
  'file',
  'about',
  'data',
  'javascript',
};

const Set<String> _nonExternalSchemes = <String>{
  'about',
  'data',
  'javascript',
};

Uri? parseWebUri(WebUri? url) {
  if (url == null) {
    return null;
  }
  return Uri.tryParse(url.toString());
}

bool shouldAllowInAppNavigation(Uri? uri) {
  if (uri == null) {
    return true;
  }
  return _inAppSchemes.contains(uri.scheme.toLowerCase());
}

bool shouldOpenExternalWindow(Uri? uri) {
  if (uri == null) {
    return false;
  }
  final scheme = uri.scheme.toLowerCase();
  if (scheme.isEmpty || _nonExternalSchemes.contains(scheme)) {
    return false;
  }
  return true;
}
