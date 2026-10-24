---
title: Use Chinese Model Providers | MANYOYO
description: Add Zhipu, DeepSeek and other providers in the web UI, share one key between Claude Code and Codex, plus subscription login and updating existing containers.
---

# Use Chinese Model Providers

Manage keys in the web UI under "System settings → Model services" — no hand-editing of config files, and no variable names on screen. One entry is one "provider + key", stored as one run profile (`runs.<name>`) in `~/.manyoyo/manyoyo.json`. Only the last 4 characters of a key are ever shown.

## Three steps in the web UI

1. Open "System settings → Model services" and click "Add model service".
2. Pick the agent (Claude Code by default — click "Codex" first to add Codex) and the provider, paste the key, save. The provider's address, model and extra settings are filled in for you; a blank name is generated automatically (like `codex-deepseek`, with a number added if taken). After saving, a test runs automatically (the model must actually run a command and read the result back); you can click "Test" in the list any time.
3. When creating a container or a quick chat, pick it from the run-profile dropdown; it shows as "Claude Code · Zhipu GLM".

If you already have a Claude Code key, a dashed card below the list says "The Zhipu GLM key can also be used by Codex" — click "Add in one click" instead of typing it again; it is tested automatically, and green "Connected" means it works. "Import from this machine" reads the keys, addresses and models already on this machine (read-only: it mounts no host directory and reads no login credentials).

## Reading the test result

- Green "Connected": the key works and the model can run commands.
- Red "Authentication failed": wrong key (or wrong plan); click "Edit" and fix it. "Details" has the server's own message.
- Red "Quota or rate limit": balance or plan quota is used up, or a plan key is used against a pay-as-you-go address.
- Red "Model not found": check the model name.
- Red "Connected, but the model did not run the command": this service or model cannot use tools; try another model.

## Providers

| Provider | Claude Code | Codex | Notes |
|---|---|---|---|
| Zhipu GLM | ✓ | ✓ (`glm-5.3`) | Plan keys and pay-as-you-go keys are not interchangeable; the wrong one reports insufficient quota |
| DeepSeek | ✓ | ✓ (`deepseek-flash`) | Create the key on the DeepSeek platform |
| Kimi | ✓ | ✓ | For Codex, enter the model name yourself |
| Volcengine Ark | ✓ | ✓ | For Codex, enter the model name yourself |
| MiniMax | ✓ | ✓ | For Codex, enter the model name yourself |
| Z.ai, Kimi Code, Alibaba Bailian, Tencent Cloud | ✓ | — | |

Each provider's official guide is linked below the provider buttons. For any other compatible service pick "Custom address".

## Good to know

- **Codex needs a model name**: Codex does not read the model from the environment; the web UI and CLI pass the model you entered. A compatible service without a model cannot be saved.
- **Zhipu + Claude Code needs "tool search" turned off**: otherwise the model cannot see Bash and cannot run any command. The preset writes `ENABLE_TOOL_SEARCH=false` automatically; add it yourself when writing the config by hand.
- **The official OpenAI key flow has not been verified** — click "Test" in the web UI before relying on it.

## Subscription login

- **Claude Code**: on any computer with a browser run `claude setup-token` and paste the long-lived token into "Subscription login"; or create the session and run `claude` in the container's terminal and follow the prompts (credentials stay in that container). Saving a token removes the API key and Base URL from the same entry, otherwise Claude Code prefers the key.
- **Codex**: in the container's terminal run `codex login --device-auth` and sign in with a browser. The login only lives in that container; a new container needs a new login.

MANYOYO never copies host login credentials into containers.

## After changing a key: existing containers

A container writes its key into its own environment at creation, so changing the config does not change it. When you edit a model service and containers still use the old key, you are told and "also update these containers" is ticked by default; the next turn uses the new key, no rebuild needed. Deleting a model service only deletes the config and does not affect existing containers.

## Command line

When a config already exists, `manyoyo setup` adds a new profile (named like `claude-zhipu`) and never overwrites the old one; start it with `manyoyo run -r <name>`.
