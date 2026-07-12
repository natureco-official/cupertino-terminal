$script:CupertinoOriginalPrompt = if (Test-Path Function:\prompt) { (Get-Item Function:\prompt).ScriptBlock } else { { 'PS> ' } }
function global:prompt {
  $exitCode = if ($?) { 0 } else { 1 }
  $cwdUri = ([Uri]$PWD.Path).AbsoluteUri
  $esc = [char]27
  $bel = [char]7
  Write-Host -NoNewline "$esc]133;D;$exitCode$bel$esc]133;A$bel$esc]7;$cwdUri$bel"
  $text = & $script:CupertinoOriginalPrompt
  return "$text$esc]133;B$bel"
}
