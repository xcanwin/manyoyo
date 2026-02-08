# Configuration Files Details

Configuration files are used to simplify MANYOYO command-line operations and avoid repetitive parameter input. Uses **JSON5 format**, supporting comments and better readability.

## Configuration File Types

MANYOYO supports two types of configuration files:

### 1. Global Configuration

**File Path**: `~/.manyoyo/manyoyo.json`

**Features**:
- Automatically loaded (when running any manyoyo command)
- Suitable for setting default images, common environment variables, etc.
- Lowest priority

**Example**:
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full"
}
```

### 2. Run Configuration

**File Path**:
- `~/.manyoyo/run/<name>.json` (using `-r <name>`)
- Or custom path (using `-r ./path.json`)

**Features**:
- Needs to be explicitly loaded (using `-r` parameter)
- Suitable for setting configurations for specific projects or tools
- Higher priority than global configuration

**Example**:
```json5
{
    "envFile": ["anthropic_claudecode"],
    "shellSuffix": "-c",
    "yolo": "c"
}
```

## Configuration Options Details

Refer to `config.example.json` to view all configurable items. Below are detailed explanations:

### Container Basic Configuration

#### containerName
- **Type**: String
- **Default**: `my-{MMDD-HHMM}` (auto-generated)
- **Description**: Container name, used to identify and manage containers
- **Example**:
```json5
{
    "containerName": "my-dev"
}
```

#### hostPath
- **Type**: String
- **Default**: Current working directory
- **Description**: Host working directory, will be mounted into the container
- **Example**:
```json5
{
    "hostPath": "/Users/username/projects/myproject"
}
```

#### containerPath
- **Type**: String
- **Default**: Same as hostPath
- **Description**: Working directory inside the container
- **Example**:
```json5
{
    "containerPath": "/workspace/myproject"
}
```

#### imageName
- **Type**: String
- **Default**: `localhost/xcanwin/manyoyo`
- **Description**: Image name (without version tag)
- **Example**:
```json5
{
    "imageName": "localhost/myuser/manyoyo"
}
```

#### imageVersion
- **Type**: String
- **Default**: None
- **Description**: Image version tag
- **Format**: `<version>-<variant>`
- **Example**:
```json5
{
    "imageVersion": "1.7.0-full"  // full version includes all tools
}
```

Available variants:
- `full` - Complete version (recommended)
- `common` - Common tools version
- Custom - Build using `--iba TOOL=xxx`

#### containerMode
- **Type**: String
- **Values**: `common`, `dind`, `sock`
- **Default**: `common`
- **Description**: Container nesting mode
- **Example**:
```json5
{
    "containerMode": "dind"  // Docker-in-Docker mode
}
```

Mode descriptions:
- `common` - Normal mode, no container nesting capability
- `dind` - Docker-in-Docker mode, secure nested containers
- `sock` - Mount Docker Socket mode (dangerous, can access everything on host)

### Environment Variable Configuration

#### envFile
- **Type**: String array
- **Merge Method**: Accumulation merge
- **Description**: Environment file list, loaded in order
- **Example**:
```json5
{
    "envFile": [
        "anthropic_claudecode",  // Loads ~/.manyoyo/env/anthropic_claudecode.env
        "secrets"                // Loads ~/.manyoyo/env/secrets.env
    ]
}
```

#### env
- **Type**: String array
- **Merge Method**: Accumulation merge
- **Description**: Directly specify environment variables
- **Example**:
```json5
{
    "env": [
        "DEBUG=true",
        "LOG_LEVEL=info"
    ]
}
```

### Mount Volume Configuration

#### volumes
- **Type**: String array
- **Merge Method**: Accumulation merge
- **Description**: Additional mount volumes
- **Format**: `host_path:container_path[:options]`
- **Example**:
```json5
{
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json",
        "/tmp/cache:/workspace/cache:ro"  // Read-only mount
    ]
}
```

### Command Configuration

#### shellPrefix
- **Type**: String
- **Description**: Command prefix, usually used to set temporary environment variables
- **Example**:
```json5
{
    "shellPrefix": "DEBUG=1"
}
```

#### shell
- **Type**: String
- **Description**: Main command to execute
- **Example**:
```json5
{
    "shell": "claude"
}
```

#### shellSuffix
- **Type**: String
- **Description**: Command suffix appended after `shell` (e.g., `-c`, `resume --last`)
- **Priority**: Can be overridden by command-line `--ss` or `-- ...` (`-- ...` has highest priority)
- **Example**:
```json5
{
    "shell": "codex",
    "shellSuffix": "resume --last"
}
```

#### yolo
- **Type**: String
- **Values**: `c`, `gm`, `cx`, `oc` (or full names `claude`, `gemini`, `codex`, `opencode`)
- **Description**: YOLO mode shortcut, skips permission confirmation
- **Example**:
```json5
{
    "yolo": "c"  // Equivalent to claude --dangerously-skip-permissions
}
```

### Other Configuration

#### quiet
- **Type**: String array
- **Values**: `tip`, `cmd`, `full`
- **Description**: Silent display options
- **Example**:
```json5
{
    "quiet": ["tip", "cmd"]  // Don't display tips and commands
}
```

#### imageBuildArgs
- **Type**: String array
- **Merge Method**: Accumulation merge
- **Description**: Image build arguments, passed to Dockerfile
- **Format**: `KEY=VALUE`
- **Example**:
```json5
{
    "imageBuildArgs": [
        "TOOL=common",
        "GIT_SSL_NO_VERIFY=true"
    ]
}
```

## Configuration Path Rules

### Run Configuration Path Resolution

```bash
# Short name (recommended)
manyoyo -r claude
# Loads: ~/.manyoyo/run/claude.json

# Relative path
manyoyo -r ./config.json
# Loads: config.json from current directory

# Absolute path
manyoyo -r /abs/path/config.json
# Loads: configuration file from specified path
```

### Global Configuration

Global configuration is always loaded from a fixed location:
```bash
~/.manyoyo/manyoyo.json
```

## Configuration Merge Rules

Refer to [Configuration System Overview](./index#priority-mechanism) for detailed merge rules.

Brief description:

### Override Parameters
Takes the value from the highest priority:
```
Command-line arguments > Run configuration > Global configuration > Default values
```

### Merge Parameters
Accumulated merge in order:
```
Global configuration + Run configuration + Command-line arguments
```

## Complete Configuration Examples

### Example: Global Configuration

```json5
// ~/.manyoyo/manyoyo.json
{
    // Use custom image
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full",

    // Global environment variables
    "env": [
        "TZ=Asia/Shanghai",
        "LANG=en_US.UTF-8"
    ],

    // Default silent tips
    "quiet": ["tip"]
}
```

### Example: Claude Code Run Configuration

```json5
// ~/.manyoyo/run/claude.json
{
    // Load Claude environment variables
    "envFile": [
        "anthropic_claudecode"
    ],

    // Use YOLO mode
    "yolo": "c",

    // Additional mount SSH configuration
    "volumes": [
        "~/.ssh:/root/.ssh:ro"
    ]
}
```

### Example: Codex Run Configuration

```json5
// ~/.manyoyo/run/codex.json
{
    // Load Codex environment variables
    "envFile": [
        "openai_[gpt]_codex"
    ],

    // Mount authentication file
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
    ],

    // Use YOLO mode
    "yolo": "cx"
}
```

### Example: Docker-in-Docker Configuration

```json5
// ~/.manyoyo/run/dind.json
{
    // Use Docker-in-Docker mode
    "containerMode": "dind",

    // Container name
    "containerName": "my-dind",

    // Additional mount Docker configuration
    "volumes": [
        "~/.docker:/root/.docker:ro"
    ]
}
```

### Example: Project-Specific Configuration

```json5
// ./myproject/.manyoyo.json
{
    // Project container name
    "containerName": "my-myproject",

    // Project environment variables
    "env": [
        "PROJECT_NAME=myproject",
        "NODE_ENV=development"
    ],

    // Use project local environment file
    "envFile": [
        "./local.env"
    ]
}
```

## Debugging Configuration

### View Final Configuration

```bash
# Display merged results from all configuration sources
manyoyo --show-config

# Display merged results for specific run configuration
manyoyo -r claude --show-config

# Display command to be executed
manyoyo -r claude --show-command
```

### Common Configuration Issues

#### Configuration Not Taking Effect

**Symptom**: After modifying configuration file, parameters are not taking effect

**Solutions**:
1. Check configuration file format (must be valid JSON5)
2. Confirm file path is correct
3. Use `--show-config` to view final configuration
4. Note that override parameters only take the highest priority value

```bash
# Verify configuration format
cat ~/.manyoyo/run/claude.json | jq .

# View final configuration
manyoyo -r claude --show-config
```

#### Configuration Conflicts

**Symptom**: Multiple configuration sources set the same parameter, uncertain which one takes effect

**Solutions**:
1. Understand priority rules (override vs merge)
2. Use `--show-config` to view final value
3. Remove conflicting items from lower priority configurations if necessary

#### Environment Variables Not Loaded

**Symptom**: envFile specified in configuration file, but environment variables not taking effect

**Solutions**:
1. Confirm environment file path is correct
2. Check environment file format
3. Use `--show-config` to view loaded environment file list
4. Run `env` command in container to verify

```bash
# View environment files in configuration
manyoyo -r claude --show-config | grep envFile

# Verify environment variables in container
manyoyo -r claude -x env | grep ANTHROPIC
```

## Best Practices

### 1. Layered Configuration

```bash
# Global configuration: Set common options
~/.manyoyo/manyoyo.json

# Run configuration: Set tool-specific options
~/.manyoyo/run/claude.json
~/.manyoyo/run/codex.json

# Project configuration: Set project-specific options
./project/.manyoyo.json
```

### 2. Use Comments

```json5
{
    // Production environment configuration
    "imageVersion": "1.7.0-full",

    // Can temporarily switch during development
    // "imageVersion": "1.6.0-common",

    "envFile": [
        "anthropic_base",    // Base configuration
        "anthropic_secrets"  // Sensitive information
    ]
}
```

### 3. Version Control

```bash
# Commit to version control
.manyoyo.json           # Project configuration
config.example.json     # Configuration example

# Exclude sensitive information
.gitignore:
  *.env
  secrets.json
```

### 4. Configuration Templates

Create configuration templates for team use:
```bash
# Copy example configuration
cp ~/.manyoyo/run/claude.example.json ~/.manyoyo/run/claude.json

# Edit configuration
vim ~/.manyoyo/run/claude.json
```

## Related Documentation

- [Configuration System Overview](./index) - Understand configuration priority mechanism
- [Environment Variables Details](./environment) - Learn how to configure environment variables
- [Configuration Examples](./examples) - View more practical examples
