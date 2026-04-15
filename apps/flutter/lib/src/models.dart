import 'dart:convert';

Map<String, dynamic> asJsonMap(Object? value) {
  if (value is Map<String, dynamic>) {
    return value;
  }
  if (value is Map) {
    return value.map((Object? key, Object? nested) => MapEntry('$key', nested));
  }
  return <String, dynamic>{};
}

List<dynamic> asJsonList(Object? value) {
  return value is List ? value : const <dynamic>[];
}

String asString(Object? value, [String fallback = '']) {
  return value is String ? value : fallback;
}

int? asInt(Object? value) {
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.toInt();
  }
  return null;
}

bool? asBool(Object? value) {
  return value is bool ? value : null;
}

class StoredSession {
  const StoredSession({
    required this.baseUrl,
    required this.username,
    required this.cookie,
  });

  final String baseUrl;
  final String username;
  final String cookie;

  bool get isAuthenticated => cookie.trim().isNotEmpty;

  Uri get uri => Uri.parse(baseUrl);

  StoredSession copyWith({String? baseUrl, String? username, String? cookie}) {
    return StoredSession(
      baseUrl: baseUrl ?? this.baseUrl,
      username: username ?? this.username,
      cookie: cookie ?? this.cookie,
    );
  }
}

class SessionSummary {
  const SessionSummary({
    required this.name,
    required this.containerName,
    required this.agentId,
    required this.agentName,
    required this.status,
    required this.image,
    required this.createdAt,
    required this.updatedAt,
    required this.messageCount,
    required this.agentEnabled,
    required this.agentProgram,
    required this.resumeSupported,
    required this.hostPath,
    required this.containerPath,
  });

  final String name;
  final String containerName;
  final String agentId;
  final String agentName;
  final String status;
  final String image;
  final String createdAt;
  final String updatedAt;
  final int messageCount;
  final bool agentEnabled;
  final String agentProgram;
  final bool resumeSupported;
  final String hostPath;
  final String containerPath;

  factory SessionSummary.fromJson(Map<String, dynamic> json) {
    return SessionSummary(
      name: asString(json['name']),
      containerName: asString(json['containerName']),
      agentId: asString(json['agentId'], 'default'),
      agentName: asString(json['agentName'], 'AGENT'),
      status: asString(json['status']),
      image: asString(json['image']),
      createdAt: asString(json['createdAt']),
      updatedAt: asString(json['updatedAt']),
      messageCount: asInt(json['messageCount']) ?? 0,
      agentEnabled: asBool(json['agentEnabled']) ?? false,
      agentProgram: asString(json['agentProgram']),
      resumeSupported: asBool(json['resumeSupported']) ?? false,
      hostPath: asString(json['hostPath']),
      containerPath: asString(json['containerPath']),
    );
  }
}

class SessionDetail extends SessionSummary {
  const SessionDetail({
    required super.name,
    required super.containerName,
    required super.agentId,
    required super.agentName,
    required super.status,
    required super.image,
    required super.createdAt,
    required super.updatedAt,
    required super.messageCount,
    required super.agentEnabled,
    required super.agentProgram,
    required super.resumeSupported,
    required super.hostPath,
    required super.containerPath,
    required this.latestRole,
    required this.latestTimestamp,
    required this.agentPromptCommand,
    required this.containerAgentPromptCommand,
    required this.agentPromptCommandOverride,
    required this.inferredAgentPromptCommand,
    required this.agentPromptSource,
    required this.lastResumeAt,
    required this.lastResumeOk,
    required this.lastResumeError,
    required this.applied,
  });

  final String latestRole;
  final String latestTimestamp;
  final String agentPromptCommand;
  final String containerAgentPromptCommand;
  final String agentPromptCommandOverride;
  final String inferredAgentPromptCommand;
  final String agentPromptSource;
  final String lastResumeAt;
  final bool? lastResumeOk;
  final String lastResumeError;
  final Map<String, dynamic> applied;

  factory SessionDetail.fromJson(Map<String, dynamic> json) {
    return SessionDetail(
      name: asString(json['name']),
      containerName: asString(json['containerName']),
      agentId: asString(json['agentId'], 'default'),
      agentName: asString(json['agentName'], 'AGENT'),
      status: asString(json['status']),
      image: asString(json['image']),
      createdAt: asString(json['createdAt']),
      updatedAt: asString(json['updatedAt']),
      messageCount: asInt(json['messageCount']) ?? 0,
      agentEnabled: asBool(json['agentEnabled']) ?? false,
      agentProgram: asString(json['agentProgram']),
      resumeSupported: asBool(json['resumeSupported']) ?? false,
      hostPath: asString(json['hostPath']),
      containerPath: asString(json['containerPath']),
      latestRole: asString(json['latestRole']),
      latestTimestamp: asString(json['latestTimestamp']),
      agentPromptCommand: asString(json['agentPromptCommand']),
      containerAgentPromptCommand: asString(
        json['containerAgentPromptCommand'],
      ),
      agentPromptCommandOverride: asString(json['agentPromptCommandOverride']),
      inferredAgentPromptCommand: asString(json['inferredAgentPromptCommand']),
      agentPromptSource: asString(json['agentPromptSource']),
      lastResumeAt: asString(json['lastResumeAt']),
      lastResumeOk: asBool(json['lastResumeOk']),
      lastResumeError: asString(json['lastResumeError']),
      applied: asJsonMap(json['applied']),
    );
  }
}

class MessageItem {
  const MessageItem({
    required this.id,
    required this.role,
    required this.content,
    required this.timestamp,
    required this.pending,
    required this.mode,
    this.exitCode,
  });

  final String id;
  final String role;
  final String content;
  final String timestamp;
  final bool pending;
  final String mode;
  final int? exitCode;

  factory MessageItem.fromJson(Map<String, dynamic> json) {
    return MessageItem(
      id: asString(json['id']),
      role: asString(json['role']),
      content: asString(json['content']),
      timestamp: asString(json['timestamp']),
      pending: asBool(json['pending']) ?? false,
      mode: asString(json['mode']),
      exitCode: asInt(json['exitCode']),
    );
  }

  MessageItem copyWith({String? content, bool? pending}) {
    return MessageItem(
      id: id,
      role: role,
      content: content ?? this.content,
      timestamp: timestamp,
      pending: pending ?? this.pending,
      mode: mode,
      exitCode: exitCode,
    );
  }
}

class AgentStreamEvent {
  const AgentStreamEvent({
    required this.type,
    required this.content,
    required this.text,
    required this.error,
    required this.exitCode,
    required this.interrupted,
  });

  final String type;
  final String content;
  final String text;
  final String error;
  final int? exitCode;
  final bool interrupted;

  factory AgentStreamEvent.fromJson(Map<String, dynamic> json) {
    return AgentStreamEvent(
      type: asString(json['type']),
      content: asString(json['content']),
      text: asString(json['text']),
      error: asString(json['error']),
      exitCode: asInt(json['exitCode']),
      interrupted: asBool(json['interrupted']) ?? false,
    );
  }
}

class RunCommandResult {
  const RunCommandResult({required this.exitCode, required this.output});

  final int? exitCode;
  final String output;

  factory RunCommandResult.fromJson(Map<String, dynamic> json) {
    return RunCommandResult(
      exitCode: asInt(json['exitCode']),
      output: asString(json['output']),
    );
  }
}

class FileNode {
  const FileNode({
    required this.name,
    required this.path,
    required this.kind,
    required this.size,
    required this.mtimeMs,
  });

  final String name;
  final String path;
  final String kind;
  final int size;
  final int mtimeMs;

  factory FileNode.fromJson(Map<String, dynamic> json) {
    return FileNode(
      name: asString(json['name']),
      path: asString(json['path']),
      kind: asString(json['kind']),
      size: asInt(json['size']) ?? 0,
      mtimeMs: asInt(json['mtimeMs']) ?? 0,
    );
  }
}

class FileListResult {
  const FileListResult({
    required this.path,
    required this.parentPath,
    required this.entries,
  });

  final String path;
  final String parentPath;
  final List<FileNode> entries;

  factory FileListResult.fromJson(Map<String, dynamic> json) {
    return FileListResult(
      path: asString(json['path']),
      parentPath: asString(json['parentPath']),
      entries: asJsonList(
        json['entries'],
      ).map((dynamic item) => FileNode.fromJson(asJsonMap(item))).toList(),
    );
  }
}

class FileReadResult {
  const FileReadResult({
    required this.path,
    required this.kind,
    required this.size,
    required this.truncated,
    required this.content,
    required this.language,
    required this.editable,
  });

  final String path;
  final String kind;
  final int size;
  final bool truncated;
  final String content;
  final String language;
  final bool editable;

  bool get isText => kind == 'text';

  factory FileReadResult.fromJson(Map<String, dynamic> json) {
    return FileReadResult(
      path: asString(json['path']),
      kind: asString(json['kind']),
      size: asInt(json['size']) ?? 0,
      truncated: asBool(json['truncated']) ?? false,
      content: asString(json['content']),
      language: asString(json['language'], 'text'),
      editable: asBool(json['editable']) ?? false,
    );
  }
}

class ConfigSnapshot {
  const ConfigSnapshot({
    required this.path,
    required this.raw,
    required this.parsed,
    required this.defaults,
    required this.parseError,
    required this.editable,
    required this.notice,
  });

  final String path;
  final String raw;
  final Map<String, dynamic> parsed;
  final Map<String, dynamic> defaults;
  final String parseError;
  final bool editable;
  final String notice;

  factory ConfigSnapshot.fromJson(Map<String, dynamic> json) {
    return ConfigSnapshot(
      path: asString(json['path']),
      raw: asString(json['raw']),
      parsed: asJsonMap(json['parsed']),
      defaults: asJsonMap(json['defaults']),
      parseError: asString(json['parseError']),
      editable: asBool(json['editable']) ?? false,
      notice: asString(json['notice']),
    );
  }
}

class CreateSessionDraft {
  const CreateSessionDraft({
    required this.run,
    required this.containerName,
    required this.hostPath,
    required this.containerPath,
    required this.imageName,
    required this.imageVersion,
    required this.containerMode,
    required this.shellPrefix,
    required this.shell,
    required this.shellSuffix,
    required this.agentPromptCommand,
    required this.yolo,
    required this.env,
    required this.envFile,
    required this.volumes,
  });

  final String run;
  final String containerName;
  final String hostPath;
  final String containerPath;
  final String imageName;
  final String imageVersion;
  final String containerMode;
  final String shellPrefix;
  final String shell;
  final String shellSuffix;
  final String agentPromptCommand;
  final String yolo;
  final Map<String, String> env;
  final List<String> envFile;
  final List<String> volumes;

  Map<String, dynamic> toJson() {
    final options = <String, dynamic>{
      'containerName': containerName.trim(),
      'hostPath': hostPath.trim(),
      'containerPath': containerPath.trim(),
      'imageName': imageName.trim(),
      'imageVersion': imageVersion.trim(),
      'containerMode': containerMode.trim(),
      'shellPrefix': shellPrefix.trim(),
      'shell': shell.trim(),
      'shellSuffix': shellSuffix.trim(),
      'agentPromptCommand': agentPromptCommand.trim(),
      'yolo': yolo.trim(),
      'env': env.map(
        (String key, String value) => MapEntry(key.trim(), value.trim()),
      ),
      'envFile': envFile.map((String item) => item.trim()).toList(),
      'volumes': volumes.map((String item) => item.trim()).toList(),
    };
    options.removeWhere(
      (String key, dynamic value) =>
          (value is String && value.isEmpty) ||
          (value is Map && value.isEmpty) ||
          (value is List && value.isEmpty),
    );
    return <String, dynamic>{
      if (run.trim().isNotEmpty) 'run': run.trim(),
      'createOptions': options,
    };
  }
}

class CreateSessionSeed {
  const CreateSessionSeed({required this.defaults, required this.runs});

  final Map<String, dynamic> defaults;
  final Map<String, Map<String, dynamic>> runs;
}

class TerminalEvent {
  const TerminalEvent({
    required this.type,
    required this.data,
    required this.phase,
    required this.error,
  });

  final String type;
  final String data;
  final String phase;
  final String error;

  factory TerminalEvent.fromJson(Map<String, dynamic> json) {
    return TerminalEvent(
      type: asString(json['type']),
      data: asString(json['data']),
      phase: asString(json['phase']),
      error: asString(json['error']),
    );
  }
}

abstract class TerminalConnection {
  Stream<TerminalEvent> get events;

  void sendInput(String data);

  void resize({required int cols, required int rows});

  Future<void> close();
}

String encodeRequestBody(Map<String, dynamic> body) {
  return jsonEncode(body);
}
