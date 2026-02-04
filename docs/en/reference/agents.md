# AI Agents

MANYOYO supports multiple AI CLI tools (agents), providing shortcuts to launch YOLO/SOLO mode.

## Supported Agents

### Claude Code

Anthropic's official Claude AI command-line tool.

**Shortcuts**:
```bash
manyoyo -y c          # Recommended
manyoyo -y claude
manyoyo -y cc
```

**Equivalent to**:
```bash
manyoyo -x claude --dangerously-skip-permissions
```

**Resume session**:
```bash
manyoyo -n <container-name> -- -c
manyoyo -n <container-name> -- --continue
```

**Configuration example**:
```json5
// ~/.manyoyo/run/claude.json
{
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
```

**Environment variables**:
```bash
# ~/.manyoyo/env/anthropic_claudecode.env
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"
```

**Common commands**:
```bash
# Start YOLO mode
manyoyo -r claude

# View version
manyoyo -r claude -- --version

# View help
manyoyo -r claude -- --help

# Resume last session
manyoyo -r claude -- -c
```

### Gemini

Google's Gemini AI command-line tool.

**Shortcuts**:
```bash
manyoyo -y gm         # Recommended
manyoyo -y gemini
manyoyo -y g
```

**Equivalent to**:
```bash
manyoyo -x gemini --skip-safety-check
```

**Resume session**:
```bash
manyoyo -n <container-name> -- -r
manyoyo -n <container-name> -- --resume
```

**Configuration example**:
```json5
// ~/.manyoyo/run/gemini.json
{
    "envFile": ["gemini"],
    "yolo": "gm"
}
```

**Environment variables**:
```bash
# ~/.manyoyo/env/gemini.env
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"
```

**Common commands**:
```bash
# Start YOLO mode
manyoyo -r gemini

# View version
manyoyo -r gemini -- --version

# Resume session
manyoyo -r gemini -- -r
```

### Codex

OpenAI's Codex command-line tool.

**Shortcuts**:
```bash
manyoyo -y cx         # Recommended
manyoyo -y codex
```

**Equivalent to**:
```bash
manyoyo -x codex --skip-permissions
```

**Resume session**:
```bash
manyoyo -n <container-name> -- resume --last
manyoyo -n <container-name> -- resume <session-id>
```

**Configuration example**:
```json5
// ~/.manyoyo/run/codex.json
{
    "envFile": ["openai_codex"],
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
    ],
    "yolo": "cx"
}
```

**Environment variables**:
```bash
# ~/.manyoyo/env/openai_codex.env
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
export OTEL_SDK_DISABLED=true
```

**Common commands**:
```bash
# Start YOLO mode
manyoyo -r codex

# View session list
manyoyo -r codex -- list

# Resume last session
manyoyo -r codex -- resume --last

# Resume specific session
manyoyo -r codex -- resume <session-id>
```

### OpenCode

Open-source AI code assistant.

**Shortcuts**:
```bash
manyoyo -y oc         # Recommended
manyoyo -y opencode
```

**Equivalent to**:
```bash
manyoyo -x opencode --yolo
```

**Resume session**:
```bash
manyoyo -n <container-name> -- -c
manyoyo -n <container-name> -- --continue
```

**Configuration example**:
```json5
// ~/.manyoyo/run/opencode.json
{
    "envFile": ["opencode"],
    "yolo": "oc"
}
```

**Environment variables**:
```bash
# ~/.manyoyo/env/opencode.env
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

**Common commands**:
```bash
# Start YOLO mode
manyoyo -r opencode

# View version
manyoyo -r opencode -- --version

# Resume session
manyoyo -r opencode -- -c
```

## YOLO Mode Explanation

YOLO (You Only Live Once) mode refers to AI agents skipping permission confirmation and automatically executing commands.

### Why Use YOLO Mode?

**Advantages**:
- Improves efficiency, reduces interaction
- Suitable for automation scenarios
- Runs in isolated containers, protecting host machine security

**Risks**:
- AI may execute dangerous commands (e.g., `rm -rf`)
- In MANYOYO containers, risks are limited to inside the container

### Security Isolation

MANYOYO provides secure container isolation:

```
Host Machine
  └─ MANYOYO Container (Isolated environment)
      └─ AI Agent (YOLO mode)
          ├─ File operations → Only affects container
          ├─ Process operations → Only affects container
          └─ Network operations → Configurable isolation
```

**Protection mechanisms**:
- Container filesystem isolation
- Resource limits
- Network isolation (optional)
- Can delete and restart containers at any time

## Agent Comparison

| Agent | Shortcut | Resume Command | Primary Use | Supported Languages |
|--------|--------|----------|----------|----------|
| Claude Code | `-y c` | `-- -c` | General programming assistance | Multi-language |
| Gemini | `-y gm` | `-- -r` | General programming assistance | Multi-language |
| Codex | `-y cx` | `-- resume --last` | Code generation | Multi-language |
| OpenCode | `-y oc` | `-- -c` | Open-source code assistant | Multi-language |

## Session Management

### Create New Session

```bash
# Create new session (auto-generate container name)
manyoyo -y c

# Create named session
manyoyo -n my-session -y c
```

### Resume Session

Different agents have different resume methods:

```bash
# Claude Code
manyoyo -n my-session -- -c

# Gemini
manyoyo -n my-session -- -r

# Codex
manyoyo -n my-session -- resume --last

# OpenCode
manyoyo -n my-session -- -c
```

### Session Persistence

Container state determines whether sessions are preserved:

```bash
# Exit and keep container running (session preserved)
# Select 'y' in interactive prompt

# Remove container (session lost)
manyoyo -n my-session --crm
```

### View Sessions

```bash
# List all container sessions
manyoyo -l

# View specific container
docker ps -a | grep my-session
```

## Switching Between Agents

### Switch Within Container

```bash
# Start Claude Code
manyoyo -n dev -y c

# After exit, enter shell
manyoyo -n dev -x /bin/bash

# Manually run other agents in shell
gemini --skip-safety-check
codex --skip-permissions
```

### Use Different Containers

```bash
# Claude Code container
manyoyo -n claude-session -y c

# Codex container
manyoyo -n codex-session -y cx

# Switch as needed
manyoyo -n claude-session -- -c
manyoyo -n codex-session -- resume --last
```

## Cycling Between Agent and /bin/bash

MANYOYO supports flexible switching between AI agents and shell:

### Switch from Agent to Shell

```bash
# Start agent
manyoyo -n dev -y c

# After working, exit agent

# Select 'i' to enter interactive shell
# Or use command
manyoyo -n dev -x /bin/bash
```

### Switch from Shell to Agent

```bash
# In shell
manyoyo -n dev -x /bin/bash

# Run agent directly inside container
claude --dangerously-skip-permissions
gemini --skip-safety-check
codex --skip-permissions

# Or exit and use command
manyoyo -n dev -y c
```

### Workflow Example

```bash
# 1. Start Claude Code for development
manyoyo -n project -y c

# 2. AI helps write code...

# 3. Exit, enter shell to check
manyoyo -n project -x /bin/bash

# 4. Manually test in shell
$ npm test
$ git status
$ ls -la

# 5. Continue using AI
$ claude --dangerously-skip-permissions

# 6. Or exit and resume
manyoyo -n project -- -c
```

## Tips and Best Practices

### Use Run Configurations

Create dedicated configuration for each agent:

```bash
# Create configuration
cat > ~/.manyoyo/run/claude.json << 'EOF'
{
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

# Use configuration (simple)
manyoyo -r claude
```

### Unified Container Naming

Use meaningful container names:

```bash
# Name by project
manyoyo -n webapp-claude -r claude
manyoyo -n api-codex -r codex

# Name by function
manyoyo -n dev-claude -r claude
manyoyo -n test-gemini -r gemini
```

### Multi-Agent Collaboration

Use multiple agents in the same project:

```bash
# Claude for architecture design
manyoyo -n project-claude --hp ~/project -r claude

# Codex for code generation
manyoyo -n project-codex --hp ~/project -r codex

# Switch usage
manyoyo -n project-claude -- -c
manyoyo -n project-codex -- resume --last
```

### Configure Environment Isolation

Configure different environments for different agents:

```bash
# Development environment - Use Claude
cat > ~/.manyoyo/run/dev.json << 'EOF'
{
    "envFile": ["anthropic_dev"],
    "env": ["NODE_ENV=development"],
    "yolo": "c"
}
EOF

# Production environment - Use Gemini
cat > ~/.manyoyo/run/prod.json << 'EOF'
{
    "envFile": ["gemini_prod"],
    "env": ["NODE_ENV=production"],
    "yolo": "gm"
}
EOF
```

## Troubleshooting

### Agent Cannot Start

**Check environment variables**:
```bash
# Verify environment variables
manyoyo -r claude --show-config

# Test environment variables
manyoyo -r claude -x 'env | grep ANTHROPIC'
```

**Check image**:
```bash
# Confirm agent is installed in image
manyoyo -x which claude
manyoyo -x which gemini
manyoyo -x which codex
```

### Session Cannot Resume

**Check container status**:
```bash
# Check if container exists
manyoyo -l
docker ps -a | grep <container-name>

# View container logs
docker logs <container-name>
```

**Use correct resume command**:
```bash
# Claude Code: -c or --continue
manyoyo -n test -- -c

# Gemini: -r or --resume
manyoyo -n test -- -r

# Codex: resume --last
manyoyo -n test -- resume --last
```

### API Authentication Failed

**Check API Key**:
```bash
# View environment file
cat ~/.manyoyo/env/anthropic_claudecode.env

# Test API
curl -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" \
     https://api.anthropic.com/v1/messages
```

**Update configuration**:
```bash
# Edit environment file
vim ~/.manyoyo/env/anthropic_claudecode.env

# Restart container
manyoyo -n test --crm
manyoyo -n test -r claude
```

## Related Documentation

- [Basic Usage](../guide/basic-usage.md) - Learn basic commands and operations
- [Configuration Examples](../configuration/examples.md) - View agent configuration examples
- [Environment Variables](../configuration/environment.md) - Learn how to configure environment variables
- [Runtime Issues](../troubleshooting/runtime-errors.md#ai-cli-tool-errors) - AI CLI tool troubleshooting
