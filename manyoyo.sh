#!/bin/bash

# ==============================================================================
# MANYOYO - AI Agent CLI Sandbox
# Install: ./manyoyo.sh --install manyoyo
# ==============================================================================

# 默认配置
CONTAINER_NAME="myy-$(date +%m%d-%H%M)" # "myy$(date +%Y%m%d%H%M%S)"
HOST_PATH="$(pwd)"
CONTAINER_PATH=$HOST_PATH # "/tmp/manyoyo"
IMAGE_NAME="localhost/xcanwin/manyoyo"
IMAGE_VERSION="1.0.0" # "latest"
EXEC_COMMAND=""
ENV_FILE=""
SHOULD_REMOVE=false
CONTAINER_ENVS=()
CONTAINER_VOLUMES=()
MANYOYO_NAME="manyoyo"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

show_help() {
    echo -e "${BLUE}Usage:${NC}"
    echo "  ${MANYOYO_NAME} [OPTIONS]"
    echo "  ${MANYOYO_NAME} [--hp HOST_PATH] [-n CONTAINER_NAME] [--cp CONTAINER_PATH] [--ef ENV_FILE] [--sp COMMAND] [-s COMMAND] [-- COMMAND]"
    echo ""
    echo -e "${BLUE}Options:${NC}"
    echo "  -l|--ls|--list                 列举容器"
    echo "  --hp|--host-path PATH          设置宿主机工作目录 (默认当前路径)"
    echo "  -n|--cn|--cont-name NAME       设置容器名称"
    echo "  --cp|--cont-path PATH          设置容器工作目录"
    echo "  --in|--image-name NAME         指定镜像名称"
    echo "  --iv|--image-ver VERSION       指定镜像版本"
    echo "  -e|--env STRING                设置环境变量"
    echo "  --ef|--env-file ENV_FILE       设置环境变量通过文件"
    echo "  -v|--volume STRING             绑定挂载卷"
    echo "  --rm|--remove-cont             删除-n容器"
    echo "  --sp|--shell-prefix COMMAND    临时环境变量 (作为-s前缀)"
    echo "  -s|--shell COMMAND             指定命令执行"
    echo "  --|--shell-suffix COMMAND      指定命令参数, --后面全部直传 (作为-s后缀)"
    echo "  -x|--shell-full COMMAND        指定完整命令执行, -x后面全部直传 (代替--sp和-s和--命令)"
    echo "  -y|--yolo CLI                  使AGENT无需确认 (代替-s命令)"
    echo "                                 例如 claude / c, gemini / gm, codex / cx, opencode / oc"
    echo "  -m|--cm|--cont-mode STRING     设置容器嵌套容器模式"
    echo "                                 例如 common, dind, mdsock"
    echo "  --install NAME                 安装manyoyo命令"
    echo "                                 例如 manyoyo, myy, docker-cli-plugin"
    echo "  -h|--help                      显示帮助"
    echo ""
    echo -e "${BLUE}Example:${NC}"
    echo "  ./${MANYOYO_NAME}.sh --install manyoyo              安装manyoyo命令"
    echo "  ${MANYOYO_NAME} -n test --ef ./xxx.env -y c         设置环境变量并运行无需确认的AGENT"
    echo "  ${MANYOYO_NAME} -n test -- -c                       恢复之前会话"
    echo "  ${MANYOYO_NAME} -x echo 123                         指定命令执行"
    echo "  ${MANYOYO_NAME} -n test --ef ./xxx.env -x claude    设置环境变量并运行"
    echo "  ${MANYOYO_NAME} -n test -x claude -c                恢复之前会话"
}
if [ $# -eq 0 ]; then
    show_help
    exit 1
fi

ensure_docker() {
    if command -v docker >/dev/null 2>&1; then
        return 0
    fi
    if command -v podman >/dev/null 2>&1; then
        shopt -s expand_aliases
        alias docker='podman'
        return 0
    fi
    echo "docker/podman not found" >&2
    return 1
}
ensure_docker

install_manyoyo() {
    MANYOYO_FILE=$(readlink -f "${BASH_SOURCE[0]}")
    case $1 in
        manyoyo) sudo ln -f -s "$MANYOYO_FILE" /usr/local/bin/manyoyo ;;
        myy) sudo ln -f -s "$MANYOYO_FILE" /usr/local/bin/myy ;;
        docker-cli-plugin) mkdir -p "$HOME/.docker/cli-plugins/"; sudo ln -f -s "$MANHOR_FILE" "$HOME/.docker/cli-plugins/docker-manhor" ;;
        *) echo -e "";;
    esac
    exit 0
}

set_yolo() {
    case $1 in
        claude|cc|c) EXEC_COMMAND="IS_SANDBOX=1 claude --dangerously-skip-permissions" ;;
        gemini|gm|g) EXEC_COMMAND="gemini --yolo" ;;
        codex|cx) EXEC_COMMAND="codex" ;;
        opencode|oc) EXEC_COMMAND="opencode" ;;
        *) echo -e "${RED}⚠️ 未知LLM CLI: $1${NC}"; exit 0 ;;
    esac
}

set_cont_mode() {
    case $1 in
        common)
            CONT_MODE=""
            ;;
        docker-in-docker|dind|d)
            CONT_MODE="--privileged"
            echo -e "${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}"
            ;;
        mount-docker-socket|mdsock|s)
            CONT_MODE="--volume /var/run/docker.sock:/var/run/docker.sock"
            echo -e "${RED}⚠️ 开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}"
            ;;
        *) echo -e "${RED}⚠️ 未知模式: $1${NC}"; exit 0 ;;
    esac
}

get_cont_list() {
    docker ps -a --size --filter "ancestor=manyoyo" \
                        --filter "ancestor=$(docker images -a --format '{{.Repository}}:{{.Tag}}' | grep manyoyo)" \
                        --format "table {{.Names}}\t{{.Status}}\t{{.Size}}\t{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Networks}}\t{{.Mounts}}"
}

add_volume() {
    CONTAINER_VOLUMES+=("--volume" "$1")
}

# 环境文件解析
add_env() {
    CONTAINER_ENVS+=("--env" "$1")
}

# 环境文件解析
add_env_file() {
    ENV_FILE=$1
    if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ $line =~ ^(export[[:space:]]+)?([a-zA-Z_][a-zA-Z0-9_]*)[[:space:]]*=[[:space:]]*([^[:space:]].*[^[:space:]])?[[:space:]]*$ ]]; then
                key="${BASH_REMATCH[2]}"; value="${BASH_REMATCH[3]}"
                #去除恶意符号
                [[ "$value" =~ [\$\(\)\`\|\&\*\{\}] ]] && continue
                [[ "$value" =~ ^\( ]] && continue
                # 去除引号
                if [[ "$value" =~ ^\"(.*)\"$ ]]; then
                    value="${BASH_REMATCH[1]}"
                elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
                    value="${BASH_REMATCH[1]}"
                fi
                [[ -n "$key" ]] && CONTAINER_ENVS+=("--env" "$key=$value")
            fi
        done < "$ENV_FILE"
    fi
}


# Docker CLI plugin metadata
if [[ "$1" == "docker-cli-plugin-metadata" ]]; then
  cat <<'EOF'
{
  "SchemaVersion": "0.1.0",
  "Vendor": "xcanwin",
  "Version": "v1.0.0",
  "Description": "AI Agent CLI Sandbox"
}
EOF
  exit 0
fi

# 参数解析
if [[ $0 == "$HOME/.docker/cli-plugins/docker-manyoyo" && "$1" == "manyoyo" ]]; then
    # 若是Docker CLI plugin则移除第一个参数
    shift
fi
while [[ $# -gt 0 ]]; do # 不传参的用shift，传参的用shift 2
    case $1 in
        -l|--ls|--list) get_cont_list; exit 0 ;;
        --hp|--host-path) HOST_PATH="$2"; shift 2 ;;
        -n|--cn|--cont-name) CONTAINER_NAME="$2"; shift 2 ;;
        --cp|--cont-path) CONTAINER_PATH="$2"; shift 2 ;;
        --in|--image-name) IMAGE_NAME="$2"; shift 2 ;;
        --iv|--image-ver) IMAGE_VERSION="$2"; shift 2 ;;
        -e|--env) add_env "$2"; shift 2 ;;
        --ef|--env-file) add_env_file "$2"; shift 2 ;;
        -v|--volume) add_volume "$2"; shift 2 ;;
        --rm|--rmc|--remove-cont) SHOULD_REMOVE=true; shift ;;
        --sp|--shell-prefix) EXEC_COMMAND_PREFIX="$2 "; shift 2 ;;
        -s|--shell) EXEC_COMMAND="$2"; shift 2 ;;
        --|--ss|--shell-suffix) shift; EXEC_COMMAND_SUFFIX=" $@"; break ;;
        -x|--sf|--shell-full) shift; EXEC_COMMAND="$@"; break ;;
        -y|--yolo) set_yolo "$2"; shift 2 ;;
        -m|--cm|--cont-mode) set_cont_mode "$2"; shift 2 ;;
        --install) install_manyoyo $2; exit 0 ;;
        -h|--help) show_help; exit 0 ;;
        *) echo -e "${RED}⚠️ 未知参数: $1${NC}"; show_help; exit 1 ;;
    esac
done
# echo "${CONTAINER_ENVS[@]}"; exit 0

# 处理删除逻辑
if [[ "$SHOULD_REMOVE" == true ]]; then
    if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
        echo -e "${YELLOW}🗑️ 正在删除容器: $CONTAINER_NAME...${NC}"
        docker rm -f "$CONTAINER_NAME" > /dev/null
        echo -e "${GREEN}✅ 已彻底删除。${NC}"
    else
        echo -e "${RED}⚠️ 错误: 未找到名为 $CONTAINER_NAME 的容器。${NC}"
    fi
    exit 0
fi

# 安全检查
case "$(realpath $HOST_PATH)" in
    "/"|"/home"|"$HOME") echo -e "${RED}⚠️ 错误: 不允许挂载根目录或home目录。${NC}"; exit 1 ;;
esac

FULL_IMAGE="$IMAGE_NAME:$IMAGE_VERSION"

# 检查容器是否存在
if ! docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    echo -e "${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}$CONTAINER_NAME${NC}\n"
    EXEC_COMMAND="${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}"
    DEFAULT_COMMAND="${EXEC_COMMAND}"
    # 后台运行一个挂起进程，使容器保持启动状态
    # 使用 --entrypoint "" 确保可以运行 tail 命令而不受镜像 Entrypoint 干扰
    docker run -d \
      --name "$CONTAINER_NAME" \
      --entrypoint "" ${CONT_MODE} \
      "${CONTAINER_ENVS[@]}" \
      "${CONTAINER_VOLUMES[@]}" \
      --volume "$HOST_PATH:$CONTAINER_PATH" \
      --workdir "$CONTAINER_PATH" \
      --label "manyoyo.default_cmd=$EXEC_COMMAND" \
      "$FULL_IMAGE" tail -f /dev/null > /dev/null

    # 等待容器就绪，防止 exec 报错 "container state improper"
    MAX_RETRIES=50
    COUNT=0
    while true; do
        STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null)
        if [[ "$STATUS" == "running" ]]; then
            break
        fi

        # 如果容器已经退出，说明启动命令失败了
        if [[ "$STATUS" == "exited" ]]; then
            echo -e "${RED}⚠️ 错误: 容器启动后立即退出。${NC}"
            docker logs "$CONTAINER_NAME"
            exit 1
        fi

        sleep 0.1
        ((COUNT++))
        if [ $COUNT -ge $MAX_RETRIES ]; then
            echo -e "${RED}⚠️ 错误: 容器启动超时（当前状态: $STATUS）。${NC}"
            docker logs "$CONTAINER_NAME"
            exit 1
        fi
    done
else
    echo -e "${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}$CONTAINER_NAME${NC}"
    # 如果容器被停止了，先启动它
    if [[ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME")" != "running" ]]; then
        docker start "$CONTAINER_NAME" > /dev/null
    fi

    # 如果本次没有提供 -s，则尝试从 Label 读取默认命令
    DEFAULT_COMMAND="$(docker inspect -f '{{index .Config.Labels "manyoyo.default_cmd"}}' "$CONTAINER_NAME")"
    if [[ -z "$EXEC_COMMAND" ]]; then
        EXEC_COMMAND="${EXEC_COMMAND_PREFIX}${DEFAULT_COMMAND}${EXEC_COMMAND_SUFFIX}"
    else
        EXEC_COMMAND="${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}"
    fi
fi

get_hello_tip() {
    echo -e "${BLUE}----------------------------------------${NC}"
    echo -e "📦 首次命令        : ${DEFAULT_COMMAND}"
    echo -e "⚫ 恢复首次命令会话: ${CYAN}${MANYOYO_NAME} -n $CONTAINER_NAME -- -c${NC}"
    echo -e "⚫ 执行首次命令    : ${GREEN}${MANYOYO_NAME} -n $CONTAINER_NAME${NC}"
    echo -e "⚫ 执行指定命令    : ${GREEN}${MANYOYO_NAME} -n $CONTAINER_NAME -x /bin/bash${NC}"
    echo -e "⚫ 执行指定命令    : ${GREEN}docker exec -it $CONTAINER_NAME /bin/bash${NC}"
    echo -e "⚫ 删除容器        : ${MANYOYO_NAME} -n $CONTAINER_NAME --rm"
    echo ""
}

get_hello_tip
echo -e "${BLUE}----------------------------------------${NC}"
echo -e "💻 执行命令: ${YELLOW}${EXEC_COMMAND:-交互式 Shell}${NC}"

# 使用 exec 进入容器执行命令或shell
if [[ -n "$EXEC_COMMAND" ]]; then
    docker exec -it "$CONTAINER_NAME" /bin/bash -c "$EXEC_COMMAND"
else
    docker exec -it "$CONTAINER_NAME" /bin/bash
fi

# 退出后的清理确认
echo ""
get_hello_tip
read -p "❔ 会话已结束。是否保留此后台容器 $CONTAINER_NAME? [ y=默认保留, n=删除, 1=首次命令进入, s=执行命令, i=交互式SHELL ]: " -n 1 -r REPLY1
echo ""

if [[ $REPLY1 =~ ^[Nn]$ ]]; then
    echo -e "${YELLOW}🗑️ 正在删除容器...${NC}"
    docker rm -f "$CONTAINER_NAME" > /dev/null
    echo -e "${GREEN}✅ 已彻底删除。${NC}"
elif [[ $REPLY1 =~ ^[1]$ ]]; then
    echo -e "${GREEN}✅ 离开当前连接，用首次命令进入。${NC}"
    exec $0 -n $CONTAINER_NAME
elif [[ $REPLY1 =~ ^[Ss]$ ]]; then
    read -p "❔ 输入要执行的命令: " -r REPLY2
    exec $0 -n $CONTAINER_NAME -x $REPLY2
elif [[ $REPLY1 =~ ^[Ii]$ ]]; then
    echo -e "${GREEN}✅ 离开当前连接，进入容器交互式SHELL。${NC}"
    exec $0 -n $CONTAINER_NAME -x /bin/bash
else
    echo -e "${GREEN}✅ 已退出连接。容器 $CONTAINER_NAME 仍在后台运行。${NC}"
fi
