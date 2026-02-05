---
title: 配置系统概览 | MANYOYO
description: 了解 MANYOYO 配置系统，包含环境变量、JSON5 配置文件、运行配置与配置优先级，适配 AI Agent CLI 场景。
---

# 配置系统概览

MANYOYO 提供灵活的配置系统，用于简化命令行操作和管理复杂的运行环境。

## 配置方式

MANYOYO 支持两种主要的配置方式：

1. **环境变量配置**：传递 BASE_URL、TOKEN 等环境变量到容器内的 CLI 工具
2. **配置文件**：使用 JSON5 格式的配置文件管理 MANYOYO 的运行参数

## JSON5 格式说明

配置文件采用 **JSON5 格式**，相比标准 JSON 具有以下优势：

- **支持注释**：可以使用 `//` 单行注释和 `/* */` 多行注释
- **尾随逗号**：数组和对象的最后一项可以有逗号
- **更灵活的键名**：对象键名可以不加引号（符合标识符规则的情况下）
- **更好的可读性**：适合人工编辑和维护

示例：
```json5
{
    // 这是注释
    containerName: "myy-dev",  // 键名可以不加引号
    imageVersion: "1.7.0-full",  // 支持尾随逗号
}
```

## 配置文件路径规则

MANYOYO 使用智能路径解析规则：

### 运行配置
- `manyoyo -r myconfig` → 加载 `~/.manyoyo/run/myconfig.json`
- `manyoyo -r ./myconfig.json` → 加载当前目录的 `myconfig.json`
- `manyoyo -r /abs/path/myconfig.json` → 加载绝对路径的配置文件

### 全局配置
- 运行任何 manyoyo 命令时，都会自动加载 `~/.manyoyo/manyoyo.json`（如果存在）

### 环境文件
- `manyoyo --ef myenv` → 加载 `~/.manyoyo/env/myenv.env`
- `manyoyo --ef ./myenv.env` → 加载当前目录的 `myenv.env`
- `manyoyo --ef /abs/path/myenv.env` → 加载绝对路径的环境文件

## 优先级机制

MANYOYO 配置参数分为两类，具有不同的合并行为：

### 覆盖型参数
这些参数只取最高优先级的值：

**优先级顺序**：命令行参数 > 运行配置 > 全局配置 > 默认值

覆盖型参数包括：
- `containerName` - 容器名称
- `hostPath` - 宿主机工作目录
- `containerPath` - 容器工作目录
- `imageName` - 镜像名称
- `imageVersion` - 镜像版本
- `containerMode` - 容器嵌套模式
- `yolo` - YOLO 模式选择
- `shellPrefix` - 命令前缀
- `shell` - 执行命令

示例：
```bash
# 全局配置中设置 imageVersion: "1.6.0-full"
# 运行配置中设置 imageVersion: "1.7.0-full"
# 最终使用 "1.7.0-full"（运行配置优先级更高）
```

### 合并型参数
这些参数会按顺序累加合并：

**合并顺序**：全局配置 + 运行配置 + 命令行参数

合并型参数包括：
- `env` - 环境变量数组
- `envFile` - 环境文件数组
- `volumes` - 挂载卷数组
- `imageBuildArgs` - 镜像构建参数数组

示例：
```bash
# 全局配置：env: ["VAR1=value1"]
# 运行配置：env: ["VAR2=value2"]
# 命令行：-e "VAR3=value3"
# 最终结果：所有三个环境变量都会生效
```

## 配置合并规则表

| 参数类型 | 参数名 | 合并行为 | 示例 |
|---------|--------|---------|------|
| 覆盖型 | `containerName` | 取最高优先级的值 | CLI `-n test` 覆盖配置文件中的值 |
| 覆盖型 | `hostPath` | 取最高优先级的值 | 默认为当前目录 |
| 覆盖型 | `containerPath` | 取最高优先级的值 | 默认与 hostPath 相同 |
| 覆盖型 | `imageName` | 取最高优先级的值 | 默认 `localhost/xcanwin/manyoyo` |
| 覆盖型 | `imageVersion` | 取最高优先级的值 | 如 `1.7.0-full` |
| 覆盖型 | `containerMode` | 取最高优先级的值 | `common`, `dind`, `sock` |
| 覆盖型 | `yolo` | 取最高优先级的值 | `c`, `gm`, `cx`, `oc` |
| 合并型 | `env` | 数组累加合并 | 全局 + 运行配置 + CLI 的所有值 |
| 合并型 | `envFile` | 数组累加合并 | 所有环境文件依次加载 |
| 合并型 | `volumes` | 数组累加合并 | 所有挂载卷生效 |
| 合并型 | `imageBuildArgs` | 数组累加合并 | 所有构建参数生效 |

## 调试配置

使用以下命令查看最终生效的配置：

```bash
# 显示最终配置
manyoyo --show-config

# 显示将要执行的命令
manyoyo --show-command
```

这些调试命令会显示所有配置源的合并结果，帮助您理解配置的优先级和合并逻辑。

## 下一步

- [环境变量详解](./environment) - 了解如何配置环境变量
- [配置文件详解](./config-files) - 学习所有配置选项
- [配置示例](./examples) - 查看实用的配置示例
