import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

abstract class ManyoyoSessionStorage {
  Future<StoredSession?> load();

  Future<void> save(StoredSession session);

  Future<void> clear();
}

class SharedPreferencesSessionStorage implements ManyoyoSessionStorage {
  SharedPreferencesSessionStorage({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync();

  static const String _baseUrlKey = 'manyoyo_flutter.base_url';
  static const String _usernameKey = 'manyoyo_flutter.username';
  static const String _cookieKey = 'manyoyo_flutter.cookie';

  final SharedPreferencesAsync _preferences;

  @override
  Future<void> clear() async {
    await _preferences.remove(_baseUrlKey);
    await _preferences.remove(_usernameKey);
    await _preferences.remove(_cookieKey);
  }

  @override
  Future<StoredSession?> load() async {
    final baseUrl = (await _preferences.getString(_baseUrlKey))?.trim() ?? '';
    final username = (await _preferences.getString(_usernameKey))?.trim() ?? '';
    final cookie = (await _preferences.getString(_cookieKey))?.trim() ?? '';
    if (baseUrl.isEmpty && username.isEmpty && cookie.isEmpty) {
      return null;
    }
    return StoredSession(
      baseUrl: baseUrl,
      username: username,
      cookie: cookie,
    );
  }

  @override
  Future<void> save(StoredSession session) async {
    await _preferences.setString(_baseUrlKey, session.baseUrl.trim());
    await _preferences.setString(_usernameKey, session.username.trim());
    await _preferences.setString(_cookieKey, session.cookie.trim());
  }
}
