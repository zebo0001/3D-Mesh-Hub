# Einmalig ausfuehren (Doppelklick oder "Mit PowerShell ausfuehren", KEINE
# Administratorrechte noetig): registriert das "meshhub://"-Protokoll fuer
# den aktuellen Windows-Benutzer (HKEY_CURRENT_USER), damit der
# "Am PC oeffnen"-Button in 3D Mesh Hub den Explorer mit der Datei
# markiert oeffnen kann.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$opener = Join-Path $scriptDir 'meshhub-opener.ps1'

if (-not (Test-Path $opener)) {
    Write-Error "meshhub-opener.ps1 nicht gefunden neben install.ps1 - bitte beide Dateien zusammen aus dem ZIP entpacken."
    exit 1
}

$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$opener`" `"%1`""

New-Item -Path 'HKCU:\Software\Classes\meshhub' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\meshhub' -Name '(Default)' -Value 'URL:MeshHub Opener Protocol'
Set-ItemProperty -Path 'HKCU:\Software\Classes\meshhub' -Name 'URL Protocol' -Value ''

New-Item -Path 'HKCU:\Software\Classes\meshhub\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\meshhub\shell\open\command' -Name '(Default)' -Value $command

Write-Host ""
Write-Host "Fertig! Das meshhub://-Protokoll ist jetzt eingerichtet." -ForegroundColor Green
Write-Host "Du kannst dieses Fenster jetzt schliessen und in 3D Mesh Hub auf 'Am PC oeffnen' klicken."
Write-Host ""
Write-Host "Hinweis: Beim allerersten Klick fragt der Browser einmalig, ob die Seite" -ForegroundColor Yellow
Write-Host "'MeshHub Opener' oeffnen darf - das ist normal und kann bestaetigt werden." -ForegroundColor Yellow
