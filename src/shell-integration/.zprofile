if [[ -n "$CUPERTINO_ORIGINAL_ZDOTDIR" && -r "$CUPERTINO_ORIGINAL_ZDOTDIR/.zprofile" ]]; then
  source "$CUPERTINO_ORIGINAL_ZDOTDIR/.zprofile"
elif [[ -r "$HOME/.zprofile" ]]; then
  source "$HOME/.zprofile"
fi
