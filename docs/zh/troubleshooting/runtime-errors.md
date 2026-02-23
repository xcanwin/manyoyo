# 运行时问题排查

本页面介绍 MANYOYO 容器运行过程中可能遇到的问题及解决方案。

## 容器启动失败

### 问题描述

执行 `manyoyo` 命令后，容器无法启动或立即退出。

### 常见错误信息

```bash
# 容器立即退出
Error: container exited with code 1

# 端口冲突
Error: address already in use

# 挂载失败
Error: error mounting ... permission denied
```

### 解决方案

#### 1. 查看容器日志

```bash
# 查看容器日志
docker logs <容器名>  # 或 podman logs

# 查看实时日志
docker logs -f <容器名>

# 查看最后 100 行日志
docker logs --tail 100 <容器名>
```

#### 2. 检查端口冲突

```bash
# 查看所有容器
docker ps -a

# 如果有端口冲突，停止冲突的容器
docker stop <冲突容器>

# 或使用不同的容器名
manyoyo run -n my-$(date +%m%d-%H%M) -y c
```

#### 3. 检查挂载权限

```bash
# 检查宿主机目录权限
ls -la /path/to/host/dir

# 修改权限（如果需要）
chmod 755 /path/to/host/dir

# 检查 SELinux 状态（如果适用）
getenforce

# 添加 SELinux 标签
chcon -Rt svirt_sandbox_file_t /path/to/host/dir
```

#### 4. 使用调试模式

```bash
# 直接进入 shell 调试
manyoyo run -n debug-container -x /bin/bash

# 查看容器内部状态
pwd
ls -la
env | sort
```

#### 5. 检查容器配置

```bash
# 查看容器详细信息
docker inspect <容器名>

# 检查挂载点
docker inspect <容器名> | jq '.[0].Mounts'

# 检查环境变量
docker inspect <容器名> | jq '.[0].Config.Env'
```

### 容器立即退出

**问题**：容器启动后立即退出

**解决方案**：
```bash
# 检查退出代码
docker ps -a | grep <容器名>

# 查看退出原因
docker logs <容器名>

# 常见原因：
# 1. 命令执行完毕（正常退出）
# 2. 命令不存在或路径错误
# 3. 环境变量缺失导致程序崩溃

# 保持容器运行（用于调试）
manyoyo run -n debug -x sleep infinity
```

### 镜像版本不匹配

**问题**：使用的镜像版本与配置不匹配

**解决方案**：
```bash
# 查看当前使用的镜像
manyoyo config show | grep imageVersion

# 查看可用镜像
docker images | grep manyoyo

# 统一版本
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageVersion": "1.8.0-common"
}
EOF
```

## 权限不足

### 问题描述

提示 `permission denied` 或无法访问 Docker/Podman。

### Docker/Podman 权限

**错误信息**：
```bash
Error: permission denied while trying to connect to the Docker daemon socket
```

**解决方案**：

#### 方案 1：添加用户到 docker 组（推荐）

```bash
# 添加当前用户到 docker 组
sudo usermod -aG docker $USER

# 重新登录或运行
newgrp docker

# 验证
docker ps
id | grep docker
```

#### 方案 2：使用 sudo（不推荐）

```bash
# 使用 sudo 运行
sudo manyoyo run -y c

# 注意：使用 sudo 可能导致配置文件路径问题
# 配置文件会从 /root/ 而不是 ~/
```

#### 方案 3：配置 Podman rootless 模式（推荐）

```bash
# Podman 默认支持 rootless 模式
# 无需 sudo，直接使用即可
podman ps

# 如果有问题，重置 Podman
podman system reset
```

### 文件访问权限

**问题**：容器内无法访问挂载的文件

**解决方案**：
```bash
# 检查文件权限
ls -la /path/to/file

# 修改文件权限
chmod 644 /path/to/file

# 修改目录权限
chmod 755 /path/to/dir

# 对于只读文件，使用只读挂载
manyoyo run -v "/path/to/file:/container/file:ro" -y c
```

### SELinux 权限问题

**问题**：在启用 SELinux 的系统上挂载失败

**解决方案**：
```bash
# 检查 SELinux 状态
getenforce

# 临时禁用（不推荐）
sudo setenforce 0

# 正确的解决方案：添加 SELinux 标签
chcon -Rt svirt_sandbox_file_t /path/to/host/dir

# 或在挂载时添加 :z 或 :Z 标志
manyoyo run -v "/path/to/dir:/container/dir:z" -y c
```

## 环境变量未生效

### 问题描述

容器内无法读取设置的环境变量，AI CLI 工具报告缺少必需的环境变量。

### 常见错误

```bash
# Claude Code
Error: Missing required environment variable: ANTHROPIC_AUTH_TOKEN

# Codex
Error: No authentication found

# Gemini
Error: API key not found
```

### 解决方案

#### 1. 检查环境文件格式

**正确的格式**：
```bash
# ~/.manyoyo/env/anthropic_claudecode.env
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
```

**常见错误**：
```bash
# 错误：使用了 Windows 换行符
export ANTHROPIC_AUTH_TOKEN="sk-xxx^M"  # ^M 是 \r\n

# 错误：缺少引号（值中有特殊字符时）
export ANTHROPIC_BASE_URL=https://api.anthropic.com/v1?key=xxx

# 错误：使用了 shell 变量替换
export TOKEN=$MY_TOKEN  # $MY_TOKEN 在构建时可能为空
```

**修复方法**：
```bash
# 转换换行符
dos2unix ~/.manyoyo/env/anthropic_claudecode.env

# 或使用 sed
sed -i 's/\r$//' ~/.manyoyo/env/anthropic_claudecode.env

# 检查文件内容
cat -A ~/.manyoyo/env/anthropic_claudecode.env
```

#### 2. 确认文件路径正确

```bash
# 检查环境文件存在
ls -la ~/.manyoyo/env/

# 检查文件名（注意大小写）
ls ~/.manyoyo/env/ | grep -i anthropic

# 测试加载
manyoyo config show --ef /abs/path/anthropic_claudecode.env
```

**路径规则**：
- `--ef` 仅支持绝对路径
- 推荐写法：`--ef /abs/path/myconfig.env`

#### 3. 使用 config show 查看配置

```bash
# 查看最终生效的配置
manyoyo config show --ef /abs/path/anthropic_claudecode.env

# 检查 envFile 是否正确加载
manyoyo config show -r claude | grep -A 5 envFile

# 检查 env 数组
manyoyo config show -r claude | grep -A 20 '"env"'
```

#### 4. 在容器中验证环境变量

```bash
# 查看所有环境变量
manyoyo run --ef /abs/path/anthropic_claudecode.env -x env

# 查看特定环境变量
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'env | grep ANTHROPIC'

# 测试 Claude Code
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'echo $ANTHROPIC_AUTH_TOKEN'
```

#### 5. 检查配置优先级

环境变量的加载顺序（后加载的会覆盖前面的）：
1. 全局配置中的 `envFile`
2. 运行配置中的 `envFile`
3. 命令行 `--ef`
4. 全局配置中的 `env`
5. 运行配置中的 `env`
6. 命令行 `-e`

**示例**：
```bash
# 如果多个配置源设置了同名变量，只有最后一个生效
# 全局配置：ANTHROPIC_MODEL=claude-sonnet-4-5
# 运行配置：ANTHROPIC_MODEL=claude-opus-4-5
# 最终结果：claude-opus-4-5（运行配置优先级更高）
```

### 环境变量值错误

**问题**：环境变量已设置，但值不正确

**解决方案**：
```bash
# 1. 检查是否有多处定义
grep -r "ANTHROPIC_AUTH_TOKEN" ~/.manyoyo/

# 2. 查看最终值
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'echo "TOKEN=$ANTHROPIC_AUTH_TOKEN"'

# 3. 检查是否有空格或特殊字符
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'env | grep ANTHROPIC | cat -A'

# 4. 使用新环境文件测试
cat > /tmp/test.env << 'EOF'
export TEST_VAR="test-value"
EOF

manyoyo run --ef /tmp/test.env -x 'echo $TEST_VAR'
```

## 容器内无法访问宿主机文件

### 问题描述

容器启动成功，但在容器内无法访问或修改宿主机文件。

### 解决方案

#### 1. 检查挂载配置

```bash
# 查看挂载点
docker inspect <容器名> | jq '.[0].Mounts'

# 默认挂载（当前目录）
manyoyo run -y c  # 挂载当前目录到容器同路径

# 自定义挂载
manyoyo run --hp /path/to/project -y c
```

#### 2. 检查路径是否正确

```bash
# 在容器中检查
manyoyo run -n test -x pwd
manyoyo run -n test -x ls -la

# 检查宿主机路径
ls -la /path/to/project
```

#### 3. 检查文件权限

```bash
# 宿主机文件权限
ls -la /path/to/file

# 容器内文件权限
manyoyo run -x ls -la /container/path/to/file

# 如果是权限问题，修改宿主机文件权限
chmod 644 /path/to/file
```

#### 4. 使用额外挂载

```bash
# 挂载额外的目录或文件
manyoyo run -v "/host/path:/container/path" -y c

# 挂载多个路径
manyoyo \
    -v "/path1:/container/path1" \
    -v "/path2:/container/path2" \
    -y c

# 只读挂载
manyoyo run -v "/sensitive:/container/sensitive:ro" -y c
```

#### 5. 配置文件中设置挂载

```json5
// ~/.manyoyo/manyoyo.json 的 runs.claude
{
    "volumes": [
        "/Users/user/.ssh:/root/.ssh:ro",
        "/Users/user/.gitconfig:/root/.gitconfig:ro",
        "/Users/user/data:/workspace/data"
    ],
    "yolo": "c"
}
```

### 符号链接问题

**问题**：挂载的目录包含符号链接，容器内无法访问

**解决方案**：
```bash
# 解析符号链接的真实路径
readlink -f /path/to/symlink

# 挂载真实路径
manyoyo run --hp $(readlink -f /path/to/dir) -y c

# 或同时挂载目标路径
manyoyo \
    -v "/real/path:/real/path" \
    -v "/symlink/path:/symlink/path" \
    -y c
```

## AI CLI 工具报错

### Claude Code 报错

#### API Key 错误

**错误信息**：
```bash
Error: Invalid API key
Error: Authentication failed
```

**解决方案**：
```bash
# 1. 检查 API Key 格式（应该以 sk- 开头）
echo $ANTHROPIC_AUTH_TOKEN

# 2. 检查环境文件
cat ~/.manyoyo/env/anthropic_claudecode.env

# 3. 测试 API Key
curl -H "x-api-key: sk-xxx" \
     -H "anthropic-version: 2023-06-01" \
     https://api.anthropic.com/v1/messages

# 4. 重新创建环境文件
cat > ~/.manyoyo/env/anthropic_claudecode.env << 'EOF'
export ANTHROPIC_AUTH_TOKEN="sk-your-actual-key-here"
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
EOF
```

#### 模型不存在

**错误信息**：
```bash
Error: model not found
```

**解决方案**：
```bash
# 检查模型名称
# 正确的模型名称：
# - claude-opus-4-5
# - claude-sonnet-4-5
# - claude-haiku-4-5

# 更新环境文件
cat >> ~/.manyoyo/env/anthropic_claudecode.env << 'EOF'
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
EOF
```

### Codex 报错

#### 认证失败

**错误信息**：
```bash
Error: No authentication found
Error: Unauthorized
```

**解决方案**：
```bash
# 确保挂载了认证文件
manyoyo run -v "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json" -y cx

# 或在配置文件中设置
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "runs": {
        "codex": {
            "envFile": ["/abs/path/openai_[gpt]_codex.env"],
            "volumes": [
                "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
            ],
            "yolo": "cx"
        }
    }
}
EOF
```

#### Base URL 错误

**错误信息**：
```bash
Error: connect ECONNREFUSED
Error: 404 Not Found
```

**解决方案**：
```bash
# 检查 Base URL
# 正确的格式：https://chatgpt.com/backend-api/codex

cat > ~/.manyoyo/env/openai_[gpt]_codex.env << 'EOF'
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
EOF
```

### Gemini 报错

#### API Key 错误

**错误信息**：
```bash
Error: API key not valid
```

**解决方案**：
```bash
# 创建正确的环境文件
cat > ~/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key-here"
export GEMINI_MODEL="gemini-2.0-flash-exp"
EOF

# 测试 API Key
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_API_KEY"
```

### OpenCode 报错

**错误信息**：
```bash
Error: Missing API key
```

**解决方案**：
```bash
# 创建环境文件
cat > ~/.manyoyo/env/opencode.env << 'EOF'
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
EOF
```

## 网络连接问题

### 容器内无法访问网络

**问题**：容器可以启动，但无法访问外部网络

**解决方案**：
```bash
# 1. 在容器中测试网络
manyoyo run -x ping -c 3 8.8.8.8
manyoyo run -x curl -I https://api.anthropic.com

# 2. 检查 DNS
manyoyo run -x cat /etc/resolv.conf

# 3. 配置 Docker/Podman DNS
# Docker: /etc/docker/daemon.json
{
    "dns": ["8.8.8.8", "114.114.114.114"]
}

# 重启 Docker
sudo systemctl restart docker

# 4. 检查防火墙
sudo firewall-cmd --list-all

# 5. 添加 Docker 网络到信任区域
sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0
sudo firewall-cmd --reload
```

### 代理设置

**问题**：需要通过代理访问网络

**解决方案**：
```bash
# 在容器中设置代理
manyoyo run -e "HTTP_PROXY=http://proxy:8080" \
        -e "HTTPS_PROXY=http://proxy:8080" \
        -e "NO_PROXY=localhost,127.0.0.1" \
        -y c

# 或在环境文件中设置
cat > ~/.manyoyo/env/proxy.env << 'EOF'
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1
EOF

manyoyo run --ef /abs/path/proxy.env --ef /abs/path/anthropic_claudecode.env -y c
```

## 性能问题

### 容器启动慢

**问题**：容器启动需要很长时间

**解决方案**：
```bash
# 1. 检查镜像大小
docker images | grep manyoyo

# 2. 使用精简版镜像
manyoyo build --iv 1.8.0-common --iba TOOL=common
manyoyo run --iv 1.8.0-common -y c

# 3. 清理无用资源
docker system prune

# 4. 检查磁盘 I/O
iostat -x 1 10
```

### 容器运行慢

**问题**：容器内命令执行很慢

**解决方案**：
```bash
# 1. 检查资源限制
docker stats <容器名>

# 2. 调整资源限制（如果使用 Docker Desktop）
# 在 Docker Desktop 设置中增加 CPU 和内存

# 3. 检查挂载性能
# 避免挂载大量小文件
# 考虑使用 volumes 而不是 bind mounts

# 4. 检查宿主机资源
top
df -h
```

## 调试技巧

### 启用详细日志

```bash
# 环境变量启用调试
manyoyo run -e "DEBUG=*" -y c

# 查看 manyoyo 执行的命令
manyoyo config command -r claude

# 查看最终配置
manyoyo config show -r claude
```

### 交互式调试

```bash
# 进入容器 shell
manyoyo run -n debug-container -x /bin/bash

# 在容器中手动测试
pwd
ls -la
env | sort
which claude
claude --version

# 测试网络
ping -c 3 api.anthropic.com
curl -I https://api.anthropic.com

# 测试环境变量
echo $ANTHROPIC_AUTH_TOKEN
```

### 容器对比

```bash
# 创建干净的容器对比
manyoyo run -n clean-test --rm-on-exit -x /bin/bash

# 创建问题容器对比
manyoyo run -n problem-test -r claude -x /bin/bash

# 对比配置差异
docker inspect clean-test > clean.json
docker inspect problem-test > problem.json
diff clean.json problem.json
```

## 相关文档

- [故障排查首页](./README.md) - 问题索引和快速导航
- [构建问题](./build-errors.md) - 镜像构建相关问题
- [配置系统](../configuration/README.md) - 配置文件和环境变量
- [命令参考](../reference/cli-options.md) - 命令行选项详解
