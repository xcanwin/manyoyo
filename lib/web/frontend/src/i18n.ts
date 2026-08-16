export type Locale = 'zh' | 'en';

type TranslationKey =
    | 'workbench'
    | 'newSession'
    | 'refresh'
    | 'searchSessions'
    | 'activity'
    | 'workspace'
    | 'lightTheme'
    | 'darkTheme'
    | 'loading'
    | 'noSessions'
    | 'noMatches'
    | 'send'
    | 'stop'
    | 'save'
    | 'reload'
    | 'close'
    | 'cancel'
    | 'create'
    | 'advancedOptions'
    | 'workspaceWidth'
    | 'messageInput'
    | 'enterPrompt'
    | 'selectSession'
    | 'saveConfig'
    | 'loadingEditor'
    | 'createContainer'
    | 'runConfig'
    | 'name'
    | 'hostPath'
    | 'mode'
    | 'sessions'
    | 'sessionTree'
    | 'messages'
    | 'chooseSession'
    | 'imageNotRecorded'
    | 'activityDescription'
    | 'creating'
    | 'newAgent'
    | 'removeContainer'
    | 'offline'
    | 'gettingStarted'
    | 'selectSessionActivity'
    | 'activityAppears'
    | 'activityMigrationNotice'
    | 'interrupted'
    | 'workspaceTabs'
    | 'terminal'
    | 'files'
    | 'details'
    | 'configuration'
    | 'doctor'
    | 'loadingTerminal'
    | 'parentDirectory'
    | 'fileList'
    | 'selectFile'
    | 'binaryFile'
    | 'cannotEdit'
    | 'saving'
    | 'fileConflict'
    | 'filePreviewTruncated'
    | 'fileContent'
    | 'defaultConfig'
    | 'containerPath'
    | 'imageName'
    | 'imageVersion'
    | 'terminalConnecting'
    | 'terminalConnected'
    | 'terminalError'
    | 'terminalClosed'
    | 'disconnected'
    | 'containerTerminal'
    | 'connectWebServiceFailed'
    | 'readSessionFailed'
    | 'readFilesFailed'
    | 'createSessionFailed'
    | 'removeSessionFailed'
    | 'createAgentFailed'
    | 'agentFailed'
    | 'stopAgentFailed'
    | 'readFileFailed'
    | 'saveFileFailed'
    | 'saveConfigFailed'
    | 'exportAudit'
    | 'exportAuditFailed';

const translations: Record<Locale, Record<TranslationKey, string>> = {
    zh: {
        workbench: '会话工作台', newSession: '新建', refresh: '刷新', searchSessions: '搜索会话（⌘/Ctrl+K）',
        activity: '活动流', workspace: '工作区', lightTheme: '浅色', darkTheme: '深色', loading: '正在加载…',
        noSessions: '暂无会话。创建容器后会显示在这里。', noMatches: '没有匹配的会话。', send: '发送', stop: '停止',
        save: '保存', reload: '重新加载', close: '关闭', cancel: '取消', create: '创建', advancedOptions: '高级选项', workspaceWidth: '工作区宽度', messageInput: '消息输入', enterPrompt: '输入 Agent 提示词', selectSession: '请先选择会话', saveConfig: '保存配置', loadingEditor: '正在加载编辑器…', createContainer: '新建容器', runConfig: '运行配置', name: '名称', hostPath: '宿主路径', mode: '模式',
        sessions: '会话', sessionTree: '会话树', messages: '条消息', chooseSession: '选择一个会话', imageNotRecorded: '未记录镜像', activityDescription: '活动流会显示 Agent 输出与控制事件。', creating: '新建中…', newAgent: '新建 Agent', removeContainer: '删除容器', offline: '连接已断开；保留最后一次会话投影，恢复后会增量同步。', gettingStarted: '准备开始', selectSessionActivity: '请选择会话以加载活动流。', activityAppears: '活动流将在此处显示', activityMigrationNotice: '此 React 工作台已连接会话、Adapter metadata 和 doctor API；后续功能会在不改变容器 mode 语义的前提下迁移。', interrupted: '任务已停止，以上输出可能未完成。', workspaceTabs: '工作区标签', terminal: '终端', files: '文件', details: '详情', configuration: '配置', doctor: '检查', loadingTerminal: '正在加载终端…', parentDirectory: '上级', fileList: '文件列表', selectFile: '选择一个文本文件以查看或编辑。', binaryFile: '二进制文件，大小', cannotEdit: '不能在浏览器中编辑。', saving: '保存中…', fileConflict: '文件已被外部修改。', filePreviewTruncated: '文件预览已截断，不能直接保存。', fileContent: '文件内容', defaultConfig: '默认配置', containerPath: '容器路径', imageName: '镜像名称', imageVersion: '镜像版本', terminalConnecting: '连接中…', terminalConnected: '已连接', terminalError: '终端异常', terminalClosed: '终端已关闭', disconnected: '已断开', containerTerminal: '容器终端', connectWebServiceFailed: '无法连接 Web 服务', readSessionFailed: '无法读取会话数据', readFilesFailed: '无法读取容器文件', createSessionFailed: '创建会话失败', removeSessionFailed: '删除会话失败', createAgentFailed: '创建 Agent 失败', agentFailed: 'Agent 执行失败', stopAgentFailed: '停止 Agent 失败', readFileFailed: '无法读取文件', saveFileFailed: '保存文件失败', saveConfigFailed: '保存配置失败', exportAudit: '导出审计 JSON', exportAuditFailed: '导出审计失败'
    },
    en: {
        workbench: 'Session workbench', newSession: 'New', refresh: 'Refresh', searchSessions: 'Search sessions (⌘/Ctrl+K)',
        activity: 'Activity', workspace: 'Workspace', lightTheme: 'Light', darkTheme: 'Dark', loading: 'Loading…',
        noSessions: 'No sessions yet. Create a container to get started.', noMatches: 'No matching sessions.', send: 'Send', stop: 'Stop',
        save: 'Save', reload: 'Reload', close: 'Close', cancel: 'Cancel', create: 'Create', advancedOptions: 'Advanced options', workspaceWidth: 'Workspace width', messageInput: 'Message input', enterPrompt: 'Enter an Agent prompt', selectSession: 'Select a session first', saveConfig: 'Save configuration', loadingEditor: 'Loading editor…', createContainer: 'New container', runConfig: 'Run configuration', name: 'Name', hostPath: 'Host path', mode: 'Mode',
        sessions: 'Sessions', sessionTree: 'Session tree', messages: 'messages', chooseSession: 'Choose a session', imageNotRecorded: 'No image recorded', activityDescription: 'The activity stream shows Agent output and control events.', creating: 'Creating…', newAgent: 'New Agent', removeContainer: 'Remove container', offline: 'Connection lost. The last session projection is retained and will sync incrementally after recovery.', gettingStarted: 'Get started', selectSessionActivity: 'Select a session to load its activity stream.', activityAppears: 'Activity will appear here', activityMigrationNotice: 'This React workbench is connected to session, Adapter metadata, and doctor APIs. Further features will migrate without changing container mode semantics.', interrupted: 'The task was stopped; the output above may be incomplete.', workspaceTabs: 'Workspace tabs', terminal: 'Terminal', files: 'Files', details: 'Details', configuration: 'Configuration', doctor: 'Doctor', loadingTerminal: 'Loading terminal…', parentDirectory: 'Parent', fileList: 'File list', selectFile: 'Select a text file to view or edit.', binaryFile: 'Binary file, size', cannotEdit: 'cannot be edited in the browser.', saving: 'Saving…', fileConflict: 'The file was changed externally.', filePreviewTruncated: 'The file preview is truncated and cannot be saved directly.', fileContent: 'File content', defaultConfig: 'Default configuration', containerPath: 'Container path', imageName: 'Image name', imageVersion: 'Image version', terminalConnecting: 'Connecting terminal…', terminalConnected: 'Connected', terminalError: 'Terminal error', terminalClosed: 'Terminal closed', disconnected: 'Disconnected', containerTerminal: 'Container terminal', connectWebServiceFailed: 'Unable to connect to the web service', readSessionFailed: 'Unable to read session data', readFilesFailed: 'Unable to read container files', createSessionFailed: 'Unable to create session', removeSessionFailed: 'Unable to remove session', createAgentFailed: 'Unable to create Agent', agentFailed: 'Agent execution failed', stopAgentFailed: 'Unable to stop Agent', readFileFailed: 'Unable to read file', saveFileFailed: 'Unable to save file', saveConfigFailed: 'Unable to save configuration', exportAudit: 'Export audit JSON', exportAuditFailed: 'Unable to export audit'
    }
};

export function getLocale(value: string | null | undefined): Locale {
    return value === 'en' ? 'en' : 'zh';
}

export function translate(locale: Locale, key: TranslationKey): string {
    return translations[locale][key];
}
