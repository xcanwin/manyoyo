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
    "imageVersion": "1.8.0-full"
}
```

### 2. Run Configuration

**Location**:
- Global configuration file: `~/.manyoyo/manyoyo.json`
- Run configuration: `runs.<name>` in `~/.manyoyo/manyoyo.json` (using `-r <name>`)

**Features**:
- Needs to be explicitly loaded (using `-r` parameter)
- Suitable for setting configurations for specific projects or tools
- Higher priority than global configuration

**Example**:
```json5
{
    "envFile": ["/abs/path/anthropic_claudecode.env"],
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
    "imageVersion": "1.8.0-full"  // full version includes all tools
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

#### serverUser
- **Type**: String
- **Default**: `admin`
- **Description**: Web login username (`serve` mode)
- **Environment Variable**: `MANYOYO_SERVER_USER`
- **Example**:
```json5
{
    "serverUser": "admin"
}
```

#### serverPass
- **Type**: String
- **Default**: Auto-generated random password when unset
- **Description**: Web login password (`serve` mode)
- **Environment Variable**: `MANYOYO_SERVER_PASS`
- **Example**:
```json5
{
    "serverPass": "change-this-password"
}
```

### Environment Variable Configuration

#### envFile
- **Type**: String array
- **Merge Method**: Accumulation merge
- **Description**: Environment file list, loaded in order (absolute paths only)
- **Example**:
```json5
{
    "envFile": [
        "/abs/path/anthropic_claudecode.env",
        "/abs/path/secrets.env"
    ]
}
```

#### env
- **Type**: Object (map)
- **Merge Method**: Merge by key (later source overrides earlier source)
- **Description**: Directly specify environment variables
- **Example**:
```json5
{
    "env": {
        "DEBUG": "true",
        "LOG_LEVEL": "info"
    }
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

#### ports
- **Type**: String array
- **Merge Method**: Accumulation merge
- **Description**: Additional port mappings (passed through as `--publish`)
- **Format**: Mapping string supported by Docker/Podman `--publish`
- **Example**:
```json5
{
    "ports": [
        "8080:80",
        "127.0.0.1:8443:443"
    ]
}
```

### Service Configuration

#### plugins.playwright
- **Type**: Object
- **Description**: Playwright plugin settings used by `manyoyo playwright` / `manyoyo plugin playwright`
- **Example**:
```json5
{
    "plugins": {
        "playwright": {
            "runtime": "mixed",  // mixed | container | host
            "enabledScenes": ["cont-headless", "cont-headed", "host-headless", "host-headed"],
            "mcpDefaultHost": "host.docker.internal",
            "vncPasswordEnvKey": "VNC_PASSWORD",
            "ports": {
                "contHeadless": 8931,
                "contHeaded": 8932,
                "hostHeadless": 8933,
                "hostHeaded": 8934,
                "contHeadedNoVnc": 6080
            }
        }
    }
}
```

`runs.<name>.plugins.playwright` can override global `plugins.playwright` for per-profile behavior.

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
# Read from runs in manyoyo.json
manyoyo run -r claude
# Loads: runs.claude in ~/.manyoyo/manyoyo.json
```

### Global Configuration

Global configuration is always loaded from a fixed location:
```bash
~/.manyoyo/manyoyo.json
```

## Configuration Merge Rules

Refer to [Configuration System Overview](./README.md#priority-mechanism) for detailed merge rules.

Brief description:

### Override Parameters
Takes the value from the highest priority:
```
Command-line arguments > runs.<name> > Global configuration > Default values
```

For `serverUser` / `serverPass`, the priority is:
```
Command-line arguments > runs.<name> > Global configuration > Environment variables > Default values
```

### Merge Parameters
Accumulated merge in order:
```
Global configuration + runs.<name> + Command-line arguments
```

## Complete Configuration Examples

### Example: Global Configuration

```json5
// ~/.manyoyo/manyoyo.json
{
    // Use custom image
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.8.0-full",

    // Global environment variables
    "env": {
        "TZ": "Asia/Shanghai",
        "LANG": "en_US.UTF-8"
    },

    // Default silent tips
    "quiet": ["tip"]
}
```

### Example: Claude Code Run Configuration

```json5
// ~/.manyoyo/manyoyo.json (fragment)
{
    // Load Claude environment variables
    "envFile": ["/abs/path/anthropic_claudecode.env"],

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
// ~/.manyoyo/manyoyo.json (fragment)
{
    // Load Codex environment variables
    "envFile": ["/abs/path/openai_[gpt]_codex.env"],

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
// ~/.manyoyo/manyoyo.json (fragment)
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
    "env": {
        "PROJECT_NAME": "myproject",
        "NODE_ENV": "development"
    },

    // Use project local environment file
    "envFile": ["/abs/path/local.env"]
}
```

## Debugging Configuration

### View Final Configuration

```bash
# Display merged results from all configuration sources
manyoyo config show

# Display merged results for specific run configuration
manyoyo config show -r claude

# Display command to be executed
manyoyo config command -r claude
```

### Common Configuration Issues

#### Configuration Not Taking Effect

**Symptom**: After modifying configuration file, parameters are not taking effect

**Solutions**:
1. Check configuration file format (must be valid JSON5)
2. Confirm file path is correct
3. Use `config show` to view final configuration
4. Note that override parameters only take the highest priority value

```bash
# Verify runs.claude structure
cat ~/.manyoyo/manyoyo.json | jq '.runs.claude'

# View final configuration
manyoyo config show -r claude
```

#### Configuration Conflicts

**Symptom**: Multiple configuration sources set the same parameter, uncertain which one takes effect

**Solutions**:
1. Understand priority rules (override vs merge)
2. Use `config show` to view final value
3. Remove conflicting items from lower priority configurations if necessary

#### Environment Variables Not Loaded

**Symptom**: envFile specified in configuration file, but environment variables not taking effect

**Solutions**:
1. Confirm environment file path is correct
2. Check environment file format
3. Use `config show` to view loaded environment file list
4. Run `env` command in container to verify

```bash
# View environment files in configuration
manyoyo config show -r claude | grep envFile

# Verify environment variables in container
manyoyo run -r claude -x env | grep ANTHROPIC
```

## Best Practices

### 1. Layered Configuration

```bash
# Global configuration: Set common options
~/.manyoyo/manyoyo.json

# Run configuration: Set tool-specific options (runs in manyoyo.json)
~/.manyoyo/manyoyo.json (runs.claude / runs.codex)

# Project configuration: Set project-specific options
./project/.manyoyo.json
```

### 2. Use Comments

```json5
{
    // Production environment configuration
    "imageVersion": "1.8.0-full",

    // Can temporarily switch during development
    // "imageVersion": "1.8.0-common",

    "envFile": [
        "/abs/path/anthropic_base.env",    // Base configuration
        "/abs/path/anthropic_secrets.env"  // Sensitive information
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
# Edit runs configuration
vim ~/.manyoyo/manyoyo.json
```

## Related Documentation

- [Configuration System Overview](./README.md) - Understand configuration priority mechanism
- [Environment Variables Details](./environment.md) - Learn how to configure environment variables
- [Configuration Examples](./examples.md) - View more practical examples
- [Web Server Auth and Security](../advanced/web-server-auth.md) - Auth behavior and security baseline for `serve`
