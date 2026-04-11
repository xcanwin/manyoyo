// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:manyoyo_flutter/main.dart';

void main() {
  testWidgets('renders manyoyo flutter placeholder', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const ManyoyoApp());
    await tester.pump();

    expect(find.text('Flutter Web 客户端已接管正式入口'), findsOneWidget);
    expect(find.text('启动页'), findsOneWidget);
    expect(find.text('推荐流程'), findsOneWidget);
    expect(find.text('当前 MANYOYO 地址'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('填入本机地址'), findsOneWidget);
    expect(find.text('保存地址'), findsOneWidget);
    expect(find.text('进入内置 MANYOYO'), findsOneWidget);
    expect(find.text('在系统浏览器打开 MANYOYO'), findsOneWidget);
    expect(find.text('配置地址'), findsOneWidget);
    expect(find.text('检测连接'), findsNWidgets(2));
    expect(find.text('进入 MANYOYO'), findsOneWidget);
    expect(find.text('macOS'), findsOneWidget);
    expect(find.text('Windows'), findsOneWidget);
    expect(find.text('iOS'), findsOneWidget);
    expect(find.text('Android'), findsOneWidget);
  });
}
