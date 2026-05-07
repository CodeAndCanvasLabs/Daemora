; Daemora Windows installer (Inno Setup 6+)
;
; Build:   iscc installer\windows\daemora.iss
; Output:  installer\windows\Output\DaemoraSetup.exe
;
; What this does at install time:
;   1. Detect Node.js >= 22. If missing, install via winget; fall back
;      to downloading the official Node 22 MSI from nodejs.org.
;   2. Run `npm install -g daemora`.
;   3. Drop launcher.ps1 + assets into the install dir.
;   4. Create Start Menu + Desktop shortcuts that run the launcher
;      silently (no PowerShell window).
;   5. Optionally launch Daemora at the end of setup.
;
; Lifecycle: the launcher spawns `daemora start` as a detached, hidden
; process and writes its PID to %APPDATA%\Daemora\daemora.pid. Closing
; the browser, the launcher, or signing out of Windows leaves the
; daemon running until the user picks "Stop Daemora" or reboots.

#define AppName "Daemora"
#define AppVersion "1.0.0"
#define AppPublisher "CodeAndCanvasLabs"
#define AppURL "https://github.com/CodeAndCanvasLabs/Daemora"
#define MinNodeMajor 22
#define NodeMsiUrl "https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi"

[Setup]
AppId={{8B2D5F3A-7A1C-4C1A-9F2E-D6B4E1A0C913}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=DaemoraSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\assets\daemora.ico
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "launcher.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\*";    DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist

[Icons]
; Main launcher (start + open browser, idempotent)
Name: "{group}\Daemora"; Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher.ps1"""; \
  IconFilename: "{app}\assets\daemora.ico"; WorkingDir: "{%USERPROFILE}"; \
  Comment: "Start Daemora and open the web app"

; Open UI only (for when daemon is already running)
Name: "{group}\Open Daemora UI"; Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher.ps1"" -OpenOnly"; \
  IconFilename: "{app}\assets\daemora.ico"; WorkingDir: "{%USERPROFILE}"; \
  Comment: "Open the Daemora web UI in your browser"

; Stop the background daemon
Name: "{group}\Stop Daemora"; Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher.ps1"" -Stop"; \
  IconFilename: "{app}\assets\daemora.ico"; WorkingDir: "{%USERPROFILE}"; \
  Comment: "Stop the background Daemora server"

Name: "{group}\{cm:UninstallProgram,Daemora}"; Filename: "{uninstallexe}"

; Desktop shortcut: 1-click start + open
Name: "{userdesktop}\Daemora"; Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher.ps1"""; \
  IconFilename: "{app}\assets\daemora.ico"; WorkingDir: "{%USERPROFILE}"; \
  Comment: "Start Daemora and open the web app"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher.ps1"""; \
  Description: "Launch Daemora now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\launcher.ps1"" -Stop"; \
  Flags: runhidden; RunOnceId: "StopDaemora"

[Code]
var
  ProgressPage: TOutputProgressWizardPage;

function IsNodeOk(): Boolean;
var
  ResultCode: Integer;
  TmpFile: string;
  NodeOut: AnsiString;
  Major: Integer;
  VersionStr: string;
  P: Integer;
begin
  Result := False;
  TmpFile := ExpandConstant('{tmp}\node-version.txt');
  if Exec(ExpandConstant('{cmd}'), '/C node --version > "' + TmpFile + '" 2>&1',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
  begin
    if LoadStringFromFile(TmpFile, NodeOut) then
    begin
      VersionStr := Trim(string(NodeOut));
      if (Length(VersionStr) > 1) and (VersionStr[1] = 'v') then
        VersionStr := Copy(VersionStr, 2, Length(VersionStr) - 1);
      P := Pos('.', VersionStr);
      if P > 0 then VersionStr := Copy(VersionStr, 1, P - 1);
      Major := StrToIntDef(VersionStr, 0);
      Result := Major >= {#MinNodeMajor};
    end;
  end;
end;

function HasWinget(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/C where winget',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function InstallNodeViaWinget(): Boolean;
var
  ResultCode: Integer;
begin
  ProgressPage.SetText('Installing Node.js via winget...', 'This may take a minute.');
  Result := Exec(ExpandConstant('{cmd}'),
                 '/C winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function InstallNodeViaMsi(): Boolean;
var
  ResultCode: Integer;
  MsiPath: string;
  Bytes: Int64;
begin
  Result := False;
  MsiPath := ExpandConstant('{tmp}\node-installer.msi');
  ProgressPage.SetText('Downloading Node.js...', 'From nodejs.org');
  // DownloadTemporaryFile returns the number of bytes written and
  // raises on failure. Wrap it so a network error doesn't crash setup.
  try
    Bytes := DownloadTemporaryFile('{#NodeMsiUrl}', 'node-installer.msi', '', nil);
  except
    Bytes := 0;
  end;
  if Bytes <= 0 then Exit;
  ProgressPage.SetText('Installing Node.js...', 'This may take a minute.');
  Result := Exec('msiexec.exe', '/i "' + MsiPath + '" /qn /norestart',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function InstallDaemora(): Boolean;
var
  ResultCode: Integer;
  LogPath: string;
begin
  ProgressPage.SetText('Installing Daemora via npm...', 'Running npm install -g daemora');
  LogPath := ExpandConstant('{tmp}\npm-install.log');
  Result := Exec(ExpandConstant('{cmd}'),
                 '/C npm install -g daemora > "' + LogPath + '" 2>&1',
                 '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then
    MsgBox('npm install -g daemora failed. See log:' + #13#10 + LogPath, mbError, MB_OK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ProgressPage := CreateOutputProgressPage('Setting up Daemora',
    'Daemora needs Node.js {#MinNodeMajor}+ and the daemora npm package. We''ll handle that now.');
  ProgressPage.Show;
  try
    if not IsNodeOk() then
    begin
      ProgressPage.SetText('Node.js {#MinNodeMajor}+ not found.', 'Installing now...');
      if HasWinget() then
      begin
        if not InstallNodeViaWinget() then
          if not InstallNodeViaMsi() then
          begin
            Result := 'Failed to install Node.js. Please install it manually from https://nodejs.org and re-run this installer.';
            Exit;
          end;
      end
      else if not InstallNodeViaMsi() then
      begin
        Result := 'Failed to download/install Node.js. Please install it manually from https://nodejs.org and re-run this installer.';
        Exit;
      end;
      if not IsNodeOk() then
      begin
        Result := 'Node.js installed but is not on PATH yet. Please reboot and re-run this installer.';
        Exit;
      end;
    end;
    if not InstallDaemora() then
    begin
      Result := 'Could not install the daemora npm package. Check your internet connection and try again.';
      Exit;
    end;
  finally
    ProgressPage.Hide;
  end;
end;
