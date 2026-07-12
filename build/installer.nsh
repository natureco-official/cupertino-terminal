!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\CupertinoTerminal" "" "Open in Cupertino Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CupertinoTerminal" "Icon" "$INSTDIR\Cupertino Terminal.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CupertinoTerminal\command" "" '"$INSTDIR\Cupertino Terminal.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CupertinoTerminal" "" "Open in Cupertino Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CupertinoTerminal" "Icon" "$INSTDIR\Cupertino Terminal.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CupertinoTerminal\command" "" '"$INSTDIR\Cupertino Terminal.exe" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\CupertinoTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\CupertinoTerminal"
!macroend
