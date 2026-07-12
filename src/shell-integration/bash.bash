if [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

__cupertino_previous_prompt_command="$PROMPT_COMMAND"
__cupertino_prompt_command() {
  local exit_code=$?
  printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' "$exit_code" "$HOSTNAME" "$PWD"
  [[ -n "$__cupertino_previous_prompt_command" ]] && eval "$__cupertino_previous_prompt_command"
}
PROMPT_COMMAND=__cupertino_prompt_command
PS1="${PS1}"$'\e]133;B\a'
