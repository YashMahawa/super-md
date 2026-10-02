Unicode True
!include "MUI2.nsh"
Name "Super MD"
OutFile "..\dist\packages\Super-MD_${VERSION}_x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Super MD"
RequestExecutionLevel user
!define MUI_ICON "..\..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\..\src-tauri\icons\icon.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Super MD" main
  SetOutPath "$INSTDIR"
  File /r "..\dist\super-md\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Super MD.lnk" "$INSTDIR\super-md.exe"
  WriteRegStr HKCU "Software\Classes\SuperMD.Note" "" "Super MD note"
  WriteRegStr HKCU "Software\Classes\SuperMD.Note\shell\open\command" "" '$\"$INSTDIR\super-md.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\Applications\super-md.exe\shell\open\command" "" '$\"$INSTDIR\super-md.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\.smd\OpenWithProgids" "SuperMD.Note" ""
  WriteRegStr HKCU "Software\Classes\.fmd\OpenWithProgids" "SuperMD.Note" ""
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "SuperMD.Note" ""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperMD" "DisplayName" "Super MD"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperMD" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperMD" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
SectionEnd
Section "Uninstall"
  Delete "$SMPROGRAMS\Super MD.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SuperMD"
  DeleteRegValue HKCU "Software\Classes\.smd\OpenWithProgids" "SuperMD.Note"
  DeleteRegValue HKCU "Software\Classes\.fmd\OpenWithProgids" "SuperMD.Note"
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "SuperMD.Note"
  DeleteRegKey HKCU "Software\Classes\SuperMD.Note"
  DeleteRegKey HKCU "Software\Classes\Applications\super-md.exe"
  RMDir /r "$INSTDIR\_internal"
  Delete "$INSTDIR\super-md.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
