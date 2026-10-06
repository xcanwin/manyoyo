# manyoyo 容器内的 env 加载：init.sh 启动自启动前加载，终端里的 `reload-env` 也用它。
# 由宿主机以只读目录挂到 /run/manyoyo-sys/env.sh，容器内不可改。
# 与宿主机侧（lib/env-text.js）同一语法：一行 KEY=VALUE，# 注释与空行忽略，可选 `export ` 前缀与 `=` 两侧空白，
# 值两端成对的引号去掉；不展开变量、不执行命令；key 必须合法
load_env() {
    local file=$1 line key val
    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%$'\r'}
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        case $line in ''|'#'*) continue ;; esac
        if [[ $line =~ ^export[[:space:]]+ ]]; then line=${line#"${BASH_REMATCH[0]}"}; fi
        [[ $line =~ ^([^=[:space:]]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
        key=${BASH_REMATCH[1]}
        val=${BASH_REMATCH[2]}
        [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        if [ "${#val}" -ge 2 ]; then
            case $val in
                \"*\") val=${val:1:${#val}-2} ;;
                \'*\') val=${val:1:${#val}-2} ;;
            esac
        fi
        export "$key=$val"
    done < "$file"
}

# 已打开的终端里让最新的环境变量生效（优先级与新开终端一致：managed < 环境变量文件 < 用户 env）
reload-env() {
    local sys=${MANYOYO_SYS_DIR:-/run/manyoyo-sys} box=${MANYOYO_BOX_DIR:-/run/manyoyo}
    load_env "$sys/managed.env"
    load_env "$sys/files.env"
    load_env "$box/env"
}
