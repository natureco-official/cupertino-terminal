if [[ -n "$CUPERTINO_ORIGINAL_ZDOTDIR" && -r "$CUPERTINO_ORIGINAL_ZDOTDIR/.zshrc" ]]; then
  source "$CUPERTINO_ORIGINAL_ZDOTDIR/.zshrc"
elif [[ -r "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi

autoload -Uz add-zsh-hook
_cupertino_precmd() {
  local exit_code=$?
  printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' "$exit_code" "$HOST" "$PWD"
}
add-zsh-hook precmd _cupertino_precmd
PROMPT="${PROMPT}%{$'\e]133;B\a'%}"
