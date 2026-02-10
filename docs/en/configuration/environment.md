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
manyoyo --ef /abs/path/anthropic_claudecode.env -x claude
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

`--ef` accepts absolute paths only:

```bash
manyoyo --ef /abs/path/myconfig.env
# Loads: file from the specified absolute path
```

## Common Examples

### Claude Code Environment Configuration

Create environment file:

```bash
# Create environment file directory (absolute path)
mkdir -p $HOME/.manyoyo/env/

# Create Claude Code environment file
cat > $HOME/.manyoyo/env/anthropic_[claudecode]_claudecode.env << 'EOF'
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
# Use from any directory (absolute path)
manyoyo --ef $HOME/.manyoyo/env/anthropic_[claudecode]_claudecode.env -x claude

# Or use with runs configuration
manyoyo -r claude  # envFile specified in runs.claude
```

### Codex Environment Configuration

Create environment file:

```bash
# Create environment file directory (absolute path)
mkdir -p $HOME/.manyoyo/env/

# Create Codex environment file
cat > $HOME/.manyoyo/env/openai_[gpt]_codex.env << 'EOF'
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
EOF
```

Use environment file:

```bash
# Use from any directory (absolute path)
manyoyo --ef $HOME/.manyoyo/env/openai_[gpt]_codex.env -x codex

# Or use with runs configuration
manyoyo -r codex  # envFile specified in runs.codex
```

### Gemini Environment Configuration

Create environment file:

```bash
# Create Gemini environment file
cat > $HOME/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"
EOF
```

Use environment file:

```bash
manyoyo --ef $HOME/.manyoyo/env/gemini.env -x gemini
```

### OpenCode Environment Configuration

Create environment file:

```bash
# Create OpenCode environment file
cat > $HOME/.manyoyo/env/opencode.env << 'EOF'
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
EOF
```

Use environment file:

```bash
manyoyo --ef $HOME/.manyoyo/env/opencode.env -x opencode
```

## Environment Variable Priority

When using configuration files, environment variables are loaded in the following order:

1. `envFile` array in global configuration
2. `envFile` array in `runs.<name>`
3. Command-line `--ef` parameter
4. `env` map in global configuration
5. `env` map in `runs.<name>`
6. Command-line `-e` parameter

**Note**: Later loaded environment variables will override earlier ones with the same name.

Example:
```bash
# Global config: envFile: ["/abs/path/base.env"]
# runs.claude: envFile: ["/abs/path/override.env"]
# Command line: --ef /abs/path/custom.env -e "VAR=value"
#
# Loading order:
# 1. /abs/path/base.env
# 2. /abs/path/override.env
# 3. /abs/path/custom.env
# 4. env map from global config
# 5. env map from runs.claude
# 6. VAR=value from command line
```

## Best Practices

### 1. Use Naming Conventions

Recommended using descriptive file names:
```bash
/abs/path/env/
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

Configure environment files in `runs` to avoid repetitive input:
```json5
// ~/.manyoyo/manyoyo.json (fragment)
{
    "runs": {
        "claude": {
            "envFile": [
                "/abs/path/anthropic_base.env",
                "/abs/path/anthropic_secrets.env"
            ]
        }
    }
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
manyoyo --show-config --ef /abs/path/myconfig.env

# Check environment variables in container
manyoyo --ef /abs/path/myconfig.env -x env
```

### Environment Variable Value Incorrect

**Symptom**: Environment variable value is not as expected

**Solutions**:
1. Check if multiple configuration sources set the same variable
2. Confirm priority order
3. Check for duplicate definitions in files

```bash
# View all effective environment variables
manyoyo --ef /abs/path/myconfig.env -x 'env | sort'
```

## Related Documentation

- [Configuration System Overview](./README.md) - Understand configuration priority mechanism
- [Configuration Files Details](./config-files.md) - Learn how to use envFile in configuration files
- [Configuration Examples](./examples.md) - View complete configuration examples
