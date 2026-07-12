$global:CupertinoOriginalPrompt = if (Test-Path Function:\prompt) { (Get-Item Function:\prompt).ScriptBlock } else { { 'PS> ' } }
function global:prompt {
  $exitCode = if ($?) { 0 } else { 1 }
  $cwdPath = $PWD.Path.Replace('\', '/')
  $cwdUri = if ($cwdPath -match '^[A-Za-z]:/') { "file:///$cwdPath" } else { "file://$env:COMPUTERNAME$cwdPath" }
  $esc = [char]27
  $bel = [char]7
  Write-Host -NoNewline "$esc]133;D;$exitCode$bel$esc]133;A$bel$esc]7;$cwdUri$bel"
  $text = & $global:CupertinoOriginalPrompt
  return "$text$esc]133;B$bel"
}
