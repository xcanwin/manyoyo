---
title: Configuration Overview | MANYOYO
description: Understand MANYOYO configuration with environment variables, JSON5 config files, run profiles, and config priority for AI Agent CLI workflows.
---

# Configuration System Overview

MANYOYO provides a flexible configuration system to simplify command-line operations and manage complex runtime environments.

## Configuration Methods

MANYOYO supports two main configuration methods:

1. **Environment Variables**: Pass environment variables like BASE_URL and TOKEN to CLI tools inside the container
2. **Configuration Files**: Manage MANYOYO runtime parameters using JSON5 format configuration files

## JSON5 Format Explanation

Configuration files use **JSON5 format**, which has the following advantages over standard JSON:

- **Support for Comments**: You can use `//` for single-line comments and `/* */` for multi-line comments
- **Trailing Commas**: Arrays and objects can have a comma after the last item
- **More Flexible Key Names**: Object keys can be unquoted (when they follow identifier rules)
- **Better Readability**: Suitable for manual editing and maintenance

Example:
```json5
{
    // This is a comment
    containerName: "my-dev",  // Keys can be unquoted
    imageVersion: "1.8.0-common",  // Trailing commas are supported
}
```

## Configuration File Path Rules

### Run Configuration
- `manyoyo run -r claude` → Loads `runs.claude` from `~/.manyoyo/manyoyo.json`
- `manyoyo run -r <name>` only accepts `runs.<name>` names, not file paths

### Global Configuration
- When running any manyoyo command, `~/.manyoyo/manyoyo.json` is automatically loaded (if it exists)

### Environment Files
- `manyoyo run --ef /abs/path/myenv.env` → Loads environment file from absolute path
- `--ef` only accepts absolute paths (no short name / relative path)

## Priority Mechanism

MANYOYO configuration parameters are divided into two categories with different merging behaviors:

### Override Parameters
These parameters only take the value from the highest priority:

**Priority Order**: Command-line arguments > `runs.<name>` > Global configuration > Default values

Override parameters include:
- `containerName` - Container name
- `hostPath` - Host working directory
- `containerPath` - Container working directory
- `imageName` - Image name
- `imageVersion` - Image version
- `containerMode` - Container nesting mode
- `yolo` - YOLO mode selection
- `shellPrefix` - Command prefix
- `shell` - Execution command
- `serverUser` - Web login username
- `serverPass` - Web login password

For web auth parameters `serverUser` / `serverPass`, environment variables are also supported with this priority:

`command-line arguments > runs.<name> > global configuration > environment variables > defaults`

Environment variable keys: `MANYOYO_SERVER_USER`, `MANYOYO_SERVER_PASS`.

Example:
```bash
# Global configuration sets imageVersion: "1.8.0-common"
# Run configuration sets imageVersion: "1.8.0-full"
# Final value is "1.8.0-full" (run configuration has higher priority)
```

### Merge Parameters
These parameters are accumulated and merged in order:

**Merge Order**: Global configuration + `runs.<name>` + Command-line arguments

Merge parameters include:
- `env` - Environment variable map (merged by key)
- `envFile` - Environment file array
- `volumes` - Mount volume array
- `ports` - Port mapping array
- `imageBuildArgs` - Image build argument array

Example:
```bash
# Global configuration: env: {"VAR1":"value1"}
# runs.demo: env: {"VAR2":"value2"}
# Command line: -e "VAR3=value3"
# Final result: VAR1/VAR2/VAR3 are effective; same key is overridden by later source
```

## Configuration Merge Rules Table

| Parameter Type | Parameter Name | Merge Behavior | Example |
|---------------|----------------|----------------|---------|
| Override | `containerName` | Takes highest priority value | CLI `-n test` overrides `runs.<name>` or global value |
| Override | `hostPath` | Takes highest priority value | Defaults to current directory |
| Override | `containerPath` | Takes highest priority value | Defaults to same as hostPath |
| Override | `imageName` | Takes highest priority value | Default `localhost/xcanwin/manyoyo` |
| Override | `imageVersion` | Takes highest priority value | e.g., `1.8.0-common` |
| Override | `containerMode` | Takes highest priority value | `common`, `dind`, `sock` |
| Override | `yolo` | Takes highest priority value | `c`, `gm`, `cx`, `oc` |
| Override | `serverUser` | Uses web auth priority order | CLI > `runs.<name>` > global > env vars > defaults |
| Override | `serverPass` | Uses web auth priority order | CLI > `runs.<name>` > global > env vars > defaults |
| Merge | `env` | Map merge by key | Global + `runs.<name>` + CLI (later source overrides same key) |
| Merge | `envFile` | Array accumulation merge | Absolute-path env files from global + `runs.<name>` + CLI |
| Merge | `volumes` | Array accumulation merge | All mount volumes take effect |
| Merge | `ports` | Array accumulation merge | All port mappings take effect (pass-through as `--publish`) |
| Merge | `imageBuildArgs` | Array accumulation merge | All build arguments take effect |

## Debugging Configuration

Use the following commands to view the final effective configuration:

```bash
# Display final configuration
manyoyo config show

# Display command to be executed
manyoyo config command
```

These debugging commands will display the merged results from all configuration sources, helping you understand the priority and merge logic of configurations.

## Next Steps

- [Environment Variables Details](./environment.md) - Learn how to configure environment variables
- [Configuration Files Details](./config-files.md) - Learn all configuration options
- [Configuration Examples](./examples.md) - View practical configuration examples
- [Web Server Auth and Security](../advanced/web-server-auth.md) - Learn auth behavior and security guidance for `serve`
