#!/usr/bin/env bash
# Claude Code status line script
# Items: used-tokens, context-used, model-with-reasoning, current-dir

input=$(cat)

total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
total_output=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
model_id=$(echo "$input" | jq -r '.model.id // ""')
model_name=$(echo "$input" | jq -r '.model.display_name // ""')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')

# used-tokens (omit when zero)
used_tokens=$((total_input + total_output))
if [ "$used_tokens" -ge 1000000 ]; then
    used_tokens_str="$(awk "BEGIN {printf \"%.1fM\", $used_tokens/1000000}") used"
elif [ "$used_tokens" -ge 1000 ]; then
    used_tokens_str="$(awk "BEGIN {printf \"%.1fk\", $used_tokens/1000}") used"
elif [ "$used_tokens" -gt 0 ]; then
    used_tokens_str="${used_tokens} used"
else
    used_tokens_str=""
fi

# context-used (omit when unknown)
if [ -n "$used_pct" ]; then
    context_used_str="$(printf "%.0f" "$used_pct")% used"
else
    context_used_str=""
fi

# model-with-reasoning
if echo "$model_id" | grep -qi "thinking\|extended"; then
    model_str="${model_name}[T]"
else
    model_str="${model_name}"
fi

# current-dir (absolute path)
if [ -n "$cwd" ]; then
    current_dir="$cwd"
else
    current_dir="$PWD"
fi

# Assemble (skip empty parts)
parts=()
[ -n "$used_tokens_str" ] && parts+=("$used_tokens_str")
[ -n "$context_used_str" ] && parts+=("$context_used_str")
[ -n "$model_str" ] && parts+=("$model_str")
[ -n "$current_dir" ] && parts+=("$current_dir")

result=""
for part in "${parts[@]}"; do
    [ -z "$result" ] && result="$part" || result="$result · $part"
done
printf "%s" "$result"
