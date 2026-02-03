# Getting Started

## Requirements

- Node.js `>=22`
- Docker or Podman (Podman recommended)

## Install manyoyo

```bash
npm install -g @xcanwin/manyoyo
```

For local development:

```bash
npm install -g .
```

## Build the sandbox image

```bash
manyoyo --ib --iv 1.7.0
```

Common build variants:

```bash
manyoyo --ib --iba TOOL=common
manyoyo --ib --iba TOOL=go,codex,java,gemini
manyoyo --ib --in myimage --iv 2.0.0
```

## Start and enter Agent mode

```bash
manyoyo -y c
```

Resume examples:

```bash
manyoyo -n test -- -c
manyoyo -n test -- resume --last
manyoyo -n test -- -r
```

## Env files and runtime config

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://xxxx" \
        -e "ANTHROPIC_AUTH_TOKEN=your-key" \
        -x claude
```

Check `README.md` and `config.example.json` for the full configuration model.
