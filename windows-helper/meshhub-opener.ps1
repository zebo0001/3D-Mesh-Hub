# Wird vom registrierten "meshhub://"-Protokoll aufgerufen, z.B.:
#   meshhub://select?path=E%3A%2FNextcloud%2F3d%2FDrucker%2FDatei.stl
# Windows uebergibt die komplette URI als einzelnes Argument ($args[0]).
# Oeffnet den Windows Explorer mit der Datei markiert (explorer /select,).

param([string]$Uri)

if (-not $Uri) { exit 0 }

# "meshhub://select?path=..." -> nur den Query-Wert von "path" extrahieren
$match = [regex]::Match($Uri, 'path=([^&]+)')
if (-not $match.Success) { exit 0 }

$encoded = $match.Groups[1].Value
$decoded = [System.Uri]::UnescapeDataString($encoded)

# Forward-Slashes (aus der Web-App) zu Windows-Backslashes
$winPath = $decoded -replace '/', '\'

if (Test-Path -LiteralPath $winPath) {
    Start-Process explorer.exe -ArgumentList "/select,`"$winPath`""
} else {
    # Datei nicht (mehr) gefunden - Ordner eine Ebene hoeher versuchen, sonst nichts tun
    $parent = Split-Path -Path $winPath -Parent
    if ($parent -and (Test-Path -LiteralPath $parent)) {
        Start-Process explorer.exe -ArgumentList "`"$parent`""
    }
}
