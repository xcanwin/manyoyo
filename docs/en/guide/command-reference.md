# Command Reference

## Frequently used commands

| Use case | Command |
| --- | --- |
| Show help | `manyoyo -h` |
| Show version | `manyoyo -V` |
| List containers | `manyoyo -l` |
| Create container and run Claude Code | `manyoyo -n test --ef .env -y c` |
| Open shell | `manyoyo -n test -x /bin/bash` |
| Execute command | `manyoyo -n test -x echo "hello world"` |
| Remove container | `manyoyo -n test --crm` |
| Remove dangling images | `manyoyo --irm` |

## Key options

| Option | Description |
| --- | --- |
| `-n, --name` | Container name |
| `-y` | Quick-start Agent mode |
| `-x` | Execute command inside container |
| `-e` | Inline environment variable |
| `--ef` | Read env file (`.env`) |
| `-r` | Read JSON5 config file |
| `--ib` | Build sandbox image |
| `--iv` | Set image version |
| `--iba` | Pass build args (for example `TOOL=common`) |
| `-q` | Quiet output (repeatable) |

## Config resolution

- `manyoyo -r myconfig` loads `~/.manyoyo/run/myconfig.json`
- `manyoyo -r ./myconfig.json` loads config from current directory
- Global `~/.manyoyo/manyoyo.json` is loaded for all runs

For complete parameter coverage, use `README.md` as the source of truth.
