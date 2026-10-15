#ifndef AppVersion
  #error AppVersion is required
#endif

[Setup]
AppId={{0A3C9CE6-338C-4CAB-B2E4-B06BEFB94AC2}
AppName=TC-06 Temperature Monitor
AppVersion={#AppVersion}
AppPublisher=TC-06 Monitor Project
AppPublisherURL=https://github.com/esp6662266/tc06-temperature-monitor
DefaultDirName={localappdata}\Programs\TC06Monitor
DefaultGroupName=TC-06 Monitor
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist\release
OutputBaseFilename=TC06Monitor-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\TC06Monitor.exe
AppMutex=Local\TC06Monitor_v1
CloseApplications=yes
RestartApplications=no
DisableProgramGroupPage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: checkedonce
Name: "autostart"; Description: "Start when I sign in to Windows"; Flags: unchecked

[Files]
Source: "..\dist\TC06Monitor\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\TC-06 Monitor"; Filename: "{app}\TC06Monitor.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\TC-06 Monitor"; Filename: "{app}\TC06Monitor.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\TC06Monitor"; Filename: "{app}\TC06Monitor.exe"; WorkingDir: "{app}"; Tasks: autostart
Name: "{group}\Temperature graph"; Filename: "https://tc06-temperature-monitor.netlify.app/?mode=graph"
Name: "{group}\Uninstall TC-06 Monitor"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\TC06Monitor.exe"; Description: "Launch TC-06 Monitor"; Flags: nowait postinstall skipifsilent
