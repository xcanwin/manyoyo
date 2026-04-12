import 'package:flutter_inappwebview/flutter_inappwebview.dart';

const Set<String> _alwaysInAppSchemes = <String>{
  'file',
  'about',
  'data',
  'javascript',
};

const Set<String> _nonExternalSchemes = <String>{'about', 'data', 'javascript'};

Uri? parseWebUri(WebUri? url) {
  if (url == null) {
    return null;
  }
  return Uri.tryParse(url.toString());
}

bool isSameOrigin(Uri? uri, Uri? baseUri) {
  if (uri == null || baseUri == null) {
    return false;
  }

  final leftScheme = uri.scheme.toLowerCase();
  final rightScheme = baseUri.scheme.toLowerCase();
  return leftScheme == rightScheme &&
      uri.host.toLowerCase() == baseUri.host.toLowerCase() &&
      uri.port == baseUri.port;
}

bool shouldAllowInAppNavigation(Uri? uri, {Uri? shellBaseUri}) {
  if (uri == null) {
    return true;
  }

  final scheme = uri.scheme.toLowerCase();
  if (_alwaysInAppSchemes.contains(scheme)) {
    return true;
  }

  if (scheme == 'http' || scheme == 'https') {
    if (shellBaseUri == null) {
      return true;
    }
    return isSameOrigin(uri, shellBaseUri);
  }

  return false;
}

bool shouldOpenExternalWindow(Uri? uri, {Uri? shellBaseUri}) {
  if (uri == null) {
    return false;
  }
  final scheme = uri.scheme.toLowerCase();
  if (scheme.isEmpty || _nonExternalSchemes.contains(scheme)) {
    return false;
  }

  if (scheme == 'http' || scheme == 'https') {
    return !shouldAllowInAppNavigation(uri, shellBaseUri: shellBaseUri);
  }

  return true;
}
