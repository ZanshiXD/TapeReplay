; Tape Replay installer (Inno Setup 6). Built by the Windows release workflow after build.py:
;   ISCC /DAppVersion=1.2.0 /DSourceExe=dist\TapeReplay.exe installer.iss   ->  dist\TapeReplay-Setup.exe
;
; Installs for the current user only, into %LOCALAPPDATA%\Programs\Tape Replay: no administrator prompt, and the
; folder stays writable so the app can update itself. Sessions and data live in %APPDATA%\TapeReplay and are kept
; on uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "dist\TapeReplay.exe"
#endif

[Setup]
; never change AppId: it is how Windows (and the app's updater) recognise this installation
AppId={{F0F0986C-E493-40FA-80F9-277161F8B799}
AppName=Tape Replay
AppVersion={#AppVersion}
AppVerName=Tape Replay {#AppVersion}
AppPublisher=ZanshiXD
AppPublisherURL=https://github.com/ZanshiXD/TapeReplay-releases
AppSupportURL=https://github.com/ZanshiXD/TapeReplay-releases
AppUpdatesURL=https://github.com/ZanshiXD/TapeReplay-releases/releases/latest
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Tape Replay
DisableDirPage=yes
DefaultGroupName=Tape Replay
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=TapeReplay-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\TapeReplay.exe
UninstallDisplayName=Tape Replay
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; a copy that is open is closed (it saves its session) before its file is replaced
CloseApplications=force
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "TapeReplay.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Tape Replay"; Filename: "{app}\TapeReplay.exe"
Name: "{autodesktop}\Tape Replay"; Filename: "{app}\TapeReplay.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\TapeReplay.exe"; Description: "Open Tape Replay"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; left behind by an update that was interrupted
Type: files; Name: "{app}\TapeReplay.exe.old"
Type: files; Name: "{app}\TapeReplay.exe.new"
