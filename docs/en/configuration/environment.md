# Environment Variables Details

Environment variables are used to pass configuration information to CLI tools inside the container, such as BASE_URL, AUTH_TOKEN, and other sensitive information.

## Setting Methods

MANYOYO supports two methods for setting environment variables:

### 1. String Form (Command Line)

Use the `-e` parameter to specify environment variables directly on the command line:

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://xxxx" -e "ANTHROPIC_AUTH_TOKEN=your-key" -x claude
```

**Features**:
- Suitable for temporary use or testing
- Supports multiple uses of the `-e` parameter
- Not suitable for sensitive information (will remain in command history)

### 2. File Form (Recommended)

Use the `--ef` parameter to load environment variables from a file:

```bash
manyoyo --ef anthropic_claudecode -x claude
```

**Features**:
- Suitable for long-term use and team collaboration
- Sensitive information does not appear in command history
- Supports version control (exclude `.env` files)
- Supports comments and better organization

## Environment File Format

Environment files use the `.env` format and support the following syntax:

```bash
# This is a comment and will be ignored

# Standard format (recommended)
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"

# Simplified format (also supported)
API_TIMEOUT_MS=3000000
ANTHROPIC_MODEL="claude-sonnet-4-5"

# Both single and double quotes are supported
TESTPATH='/usr/local/bin'
MESSAGE="Hello World"

# Comments can be placed anywhere
# export DISABLED_VAR="will not take effect"
```

**Notes**:
- Lines starting with `#` are ignored
- Supports both `KEY=VALUE` and `export KEY=VALUE` formats
- Values can use single quotes, double quotes, or no quotes
- Empty lines are ignored

## Environment File Path Rules

MANYOYO uses intelligent path resolution:

### Short Name (Recommended)
```bash
manyoyo --ef myconfig
# Loads: ~/.manyoyo/env/myconfig.env
```

### Relative Path
```bash
manyoyo --ef ./myconfig.env
# Loads: myconfig.env from current directory
```

### Absolute Path
```bash
manyoyo --ef /abs/path/myconfig.env
# Loads: file from specified absolute path
```

## Common Examples

### Claude Code Environment Configuration

Create environment file:

```bash
# Create environment file directory
mkdir -p ~/.manyoyo/env/

# Create Claude Code environment file
cat > ~/.manyoyo/env/anthropic_[claudecode]_claudecode.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
# export CLAUDE_CODE_OAUTH_TOKEN="sk-xxxxxxxx"  # OAuth method
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"        # API Key method
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"
EOF
```

Use environment file:

```bash
# Use from any directory
manyoyo --ef anthropic_[claudecode]_claudecode -x claude

# Or use with run configuration
manyoyo -r claude  # envFile specified in config file
```

### Codex Environment Configuration

Create environment file:

```bash
# Create environment file directory
mkdir -p ~/.manyoyo/env/

# Create Codex environment file
cat > ~/.manyoyo/env/openai_[gpt]_codex.env << 'EOF'
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
EOF
```

Use environment file:

```bash
# Use from any directory
manyoyo --ef openai_[gpt]_codex -x codex

# Or use with run configuration
manyoyo -r codex  # envFile specified in config file
```

### Gemini Environment Configuration

Create environment file:

```bash
# Create Gemini environment file
cat > ~/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"
EOF
```

Use environment file:

```bash
manyoyo --ef gemini -x gemini
```

### OpenCode Environment Configuration

Create environment file:

```bash
# Create OpenCode environment file
cat > ~/.manyoyo/env/opencode.env << 'EOF'
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
EOF
```

Use environment file:

```bash
manyoyo --ef opencode -x opencode
```

## Environment Variable Priority

When using configuration files, environment variables are loaded in the following order:

1. `envFile` array in global configuration
2. `envFile` array in run configuration
3. Command-line `--ef` parameter
4. `env` array in global configuration
5. `env` array in run configuration
6. Command-line `-e` parameter

**Note**: Later loaded environment variables will override earlier ones with the same name.

Example:
```bash
# Global config: envFile: ["base"]
# Run config: envFile: ["override"]
# Command line: --ef custom -e "VAR=value"
#
# Loading order:
# 1. ~/.manyoyo/env/base.env
# 2. ~/.manyoyo/env/override.env
# 3. ~/.manyoyo/env/custom.env
# 4. env array from global config
# 5. env array from run config
# 6. VAR=value from command line
```

## Best Practices

### 1. Use Naming Conventions

Recommended using descriptive file names:
```bash
~/.manyoyo/env/
├── anthropic_[claudecode]_claudecode.env
├── openai_[gpt]_codex.env
├── gemini_production.env
└── opencode_dev.env
```

### 2. Separate Sensitive Information

Store sensitive information (such as API Keys) separately:
```bash
# base.env - Non-sensitive configuration
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export API_TIMEOUT_MS=3000000

# secrets.env - Sensitive information (do not commit to version control)
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
```

### 3. Use Configuration Files for Management

Configure environment files in run configurations to avoid repetitive input:
```json5
// ~/.manyoyo/run/claude.json
{
    "envFile": [
        "anthropic_base",
        "anthropic_secrets"
    ]
}
```

### 4. Verify Environment Variables

Use debugging commands to verify that environment variables are loaded correctly:
```bash
# View final configuration
manyoyo --show-config -r claude

# Verify in container
manyoyo -r claude -x env | grep ANTHROPIC
```

## Troubleshooting

### Environment Variables Not Taking Effect

**Symptom**: CLI tool reports missing required environment variables

**Solutions**:
1. Check file format (must be `.env` format)
2. Confirm file path is correct
3. Use `--show-config` to view configuration
4. Run `env` command in container to check

```bash
# Check configuration
manyoyo --show-config --ef myconfig

# Check environment variables in container
manyoyo --ef myconfig -x env
```

### Environment Variable Value Incorrect

**Symptom**: Environment variable value is not as expected

**Solutions**:
1. Check if multiple configuration sources set the same variable
2. Confirm priority order
3. Check for duplicate definitions in files

```bash
# View all effective environment variables
manyoyo --ef myconfig -x 'env | sort'
```

## Related Documentation

- [Configuration System Overview](./index) - Understand configuration priority mechanism
- [Configuration Files Details](./config-files) - Learn how to use envFile in configuration files
- [Configuration Examples](./examples) - View complete configuration examples
