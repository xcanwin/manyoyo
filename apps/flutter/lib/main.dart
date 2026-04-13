import 'dart:async';

import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/app_controller.dart';
import 'src/repository.dart';
import 'src/session_storage.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = ManyoyoAppController(
    repository: HttpManyoyoRepository(),
    storage: SharedPreferencesSessionStorage(),
  );
  runApp(ManyoyoApp(controller: controller));
  unawaited(controller.initialize());
}
