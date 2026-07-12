if [[ -n "$CUPERTINO_ORIGINAL_ZDOTDIR" && -r "$CUPERTINO_ORIGINAL_ZDOTDIR/.zlogin" ]]; then
  source "$CUPERTINO_ORIGINAL_ZDOTDIR/.zlogin"
elif [[ -r "$HOME/.zlogin" ]]; then
  source "$HOME/.zlogin"
fi
