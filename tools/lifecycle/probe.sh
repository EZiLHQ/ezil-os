#!/usr/bin/env bash
# Read-only snapshot. Only the named inputs below are inspected; no env dump.
set -u
set -o pipefail

json_string() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import json,sys; print(json.dumps(sys.argv[1]), end="")' "$1"
        return
    fi
    local LC_ALL=C value=$1 char code i
    printf '"'
    for ((i=0; i<${#value}; i++)); do
        char=${value:i:1}
        case "$char" in
            '"') printf '\\"' ;;
            '\') printf '\\\\' ;;
            *)
                printf -v code '%d' "'$char"
                if ((code < 32)); then printf '\\u%04x' "$code"; else printf '%s' "$char"; fi
                ;;
        esac
    done
    printf '"'
}

command_json() {
    local output
    if output=$("$@" 2>/dev/null); then json_string "$output"; else printf 'null'; fi
}

file_json() {
    local output
    if [[ -r $1 ]] && output=$(cat -- "$1" 2>/dev/null); then
        json_string "$output"
    else
        printf 'null'
    fi
}

sha256_json() {
    local output
    if [[ -f $1 && -r $1 ]] && output=$(sha256sum 2>/dev/null < "$1"); then
        json_string "${output%% *}"
    else
        printf 'null'
    fi
}

process_json() {
    local pid=$1 stat_line rest comm
    local -a fields
    if [[ ! $pid =~ ^[1-9][0-9]*$ ]] || ! IFS= read -r stat_line 2>/dev/null < "/proc/$pid/stat"; then
        printf 'null'
        return
    fi
    # comm can contain spaces and ')': field 3 begins after the LAST ') '.
    rest=${stat_line##*) }
    read -r -a fields <<< "$rest"
    if [[ ! ${fields[19]:-} =~ ^[0-9]+$ ]]; then printf 'null'; return; fi
    comm=${stat_line#*(}
    comm=${comm%)*}
    printf '{"pid":%s,"starttime":' "$pid"
    json_string "${fields[19]}"
    printf ',"comm":'
    json_string "$comm"
    printf '}'
}

code_server_pids=()
pty_host_pids=()
tmux_server_pids=()
for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir##*/}
    [[ $pid == "$$" ]] && continue
    comm=''
    IFS= read -r comm 2>/dev/null < "$proc_dir/comm" || continue
    # Inspect argv only for identification; never emit argv (it can contain secrets).
    args=()
    if [[ -r $proc_dir/cmdline ]]; then
        mapfile -d '' -t args 2>/dev/null < "$proc_dir/cmdline" || continue
    fi
    is_code_server=false
    is_pty_host=false
    for arg in "${args[@]}"; do
        case "$arg" in
            code-server|*/code-server|*/code-server/*) is_code_server=true ;;
        esac
        [[ $arg == *ptyHost* ]] && is_pty_host=true
    done
    if [[ $comm == code-server ]] || $is_code_server; then code_server_pids+=("$pid"); fi
    if $is_pty_host; then pty_host_pids+=("$pid"); fi
    [[ $comm == 'tmux: server' ]] && tmux_server_pids+=("$pid")
done

process_list_json() {
    local pid record separator=''
    local -a records=()
    for pid in "$@"; do
        record=$(process_json "$pid")
        [[ $record == null ]] || records+=("$record")
    done
    if ((${#records[@]} == 0)); then printf 'null'; return; fi
    printf '['
    for record in "${records[@]}"; do printf '%s%s' "$separator" "$record"; separator=','; done
    printf ']'
}

tool_json() {
    local name=$1 path resolved output inode links size
    printf '{"path":'
    if path=$(command -v -- "$name" 2>/dev/null); then json_string "$path"; else path=''; printf 'null'; fi
    printf ',"realpath":'
    if [[ -n $path ]] && resolved=$(readlink -f -- "$path" 2>/dev/null); then
        json_string "$resolved"
    else
        printf 'null'
    fi
    printf ',"version":'
    if [[ -n $path ]]; then command_json timeout 10 "$name" --version; else printf 'null'; fi
    printf ',"sha256":'
    sha256_json "$path"
    printf ',"stat":'
    if [[ -n $path ]] && output=$(stat -L -c '%i %h %s' -- "$path" 2>/dev/null); then
        read -r inode links size <<< "$output"
        printf '{"inode":'; json_string "$inode"
        printf ',"links":'; json_string "$links"
        printf ',"size":'; json_string "$size"
        printf '}'
    else
        printf 'null'
    fi
    printf '}'
}

printf '{"identity":{"boot_id":'
file_json /proc/sys/kernel/random/boot_id
printf ',"hostname":'; command_json hostname
printf ',"pid_namespace":'; command_json readlink /proc/self/ns/pid
printf ',"uid":'; command_json id -u
printf ',"home":'
if [[ ${HOME+x} ]]; then json_string "$HOME"; else printf 'null'; fi
if [[ ${CLOUDFLARE_DEPLOYMENT_ID+x} ]]; then
    printf ',"CLOUDFLARE_DEPLOYMENT_ID":'; json_string "$CLOUDFLARE_DEPLOYMENT_ID"
fi
if [[ ${CLOUDFLARE_DURABLE_OBJECT_ID+x} ]]; then
    printf ',"CLOUDFLARE_DURABLE_OBJECT_ID":'; json_string "$CLOUDFLARE_DURABLE_OBJECT_ID"
fi
printf '},"processes":{"code_server":'; process_list_json "${code_server_pids[@]}"
printf ',"code_server_version":'; command_json timeout 10 code-server --version
printf ',"pty_host":'; process_list_json "${pty_host_pids[@]}"
printf ',"tmux_server":'; process_list_json "${tmux_server_pids[@]}"
printf ',"shell":'; process_json "$PPID"
printf ',"sentinel_requested":'
if [[ ${EZIL_LC_SENTINEL_PID+x} ]]; then printf 'true'; else printf 'false'; fi
printf ',"sentinel":'; process_json "${EZIL_LC_SENTINEL_PID:-}"
printf '},"tools":{"npm_prefix":'
# Disable npm log files and its update notifier while reading the global prefix.
command_json timeout 10 npm prefix -g --logs-max=0 --update-notifier=false
printf ',"PATH":'
if [[ ${PATH+x} ]]; then json_string "$PATH"; else printf 'null'; fi
printf ',"commands":{'
tool_names=()
IFS=$' \t\n' read -r -d '' -a tool_names < <(printf '%s\0' "${EZIL_LC_TOOLS-opencode}")
separator=''
declare -A seen_tools=()
for name in "${tool_names[@]}"; do
    [[ ${seen_tools[$name]+x} ]] && continue
    seen_tools[$name]=1
    printf '%s' "$separator"; json_string "$name"; printf ':'; tool_json "$name"
    separator=','
done
printf '}},"config":{"bashrc":{"sha256":'; sha256_json "${HOME:-}/.bashrc"
printf '},"bash_history":{"sha256":'; sha256_json "${HOME:-}/.bash_history"
printf ',"lines":'
if [[ -f ${HOME:-}/.bash_history ]] && output=$(wc -l 2>/dev/null < "${HOME:-}/.bash_history") && [[ ${output//[[:space:]]/} =~ ^[0-9]+$ ]]; then
    printf '%s' "${output//[[:space:]]/}"
else
    printf 'null'
fi
printf ',"marker_present":'
if [[ ${EZIL_LC_MARKER+x} && -r ${HOME:-}/.bash_history ]] && command -v grep >/dev/null 2>&1; then
    grep -Fq -- "$EZIL_LC_MARKER" "${HOME:-}/.bash_history" 2>/dev/null
    rc=$?
    case $rc in 0) printf 'true';; 1) printf 'false';; *) printf 'null';; esac
else
    printf 'null'
fi
printf '},"settings":{"sha256":'; sha256_json /workspace/.ezil/settings.json
printf '}},"project":'
if [[ ${EZIL_LC_PROJECT+x} ]]; then
    printf '{"path":'; json_string "$EZIL_LC_PROJECT"
    printf ',"HEAD":'; command_json git --no-optional-locks -C "$EZIL_LC_PROJECT" rev-parse --verify HEAD
    printf ',"files":{'
    file_names=()
    IFS=$' \t\n' read -r -d '' -a file_names < <(printf '%s\0' "${EZIL_LC_FILES:-}")
    separator=''
    declare -A seen_files=()
    for name in "${file_names[@]}"; do
        [[ ${seen_files[$name]+x} ]] && continue
        seen_files[$name]=1
        printf '%s' "$separator"; json_string "$name"; printf ':'
        sha256_json "$EZIL_LC_PROJECT/$name"
        separator=','
    done
    printf '}}'
else
    printf 'null'
fi
printf ',"mounts":{'
separator=''
for target in / /workspace /root /usr/local; do
    printf '%s' "$separator"; json_string "$target"; printf ':'
    command_json findmnt -rn -M "$target" -o TARGET,SOURCE,FSTYPE
    separator=','
done
printf '}}\n'
