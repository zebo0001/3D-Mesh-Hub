# Changelog

Alle nennenswerten Aenderungen an 3D Mesh Hub werden hier dokumentiert.
Das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/) (MAJOR.MINOR.PATCH).

## [1.6.0] - 2026-10-01

### Hinzugefuegt
- Lager-Integration: Spule aus dem Lagersystem (Spoolman-Erweiterung) im Datei-Detail waehlen statt Farbe/Gramm manuell einzutragen, Verbrauch per "Wird gedruckt"-Button direkt auf die Spule buchen.
- Neue Einstellungen: Lager-Integration an/aus + Lager-Service-URL, inkl. "Verbindung testen"-Button.
- "Bibliotheken"-Button in "Einstellungen" umbenannt (mehr als nur Bibliotheken konfigurierbar).

### Geaendert
- "Nur Slicer"-Berechnungsmethode vorerst deaktiviert (bekannter OrcaSlicer-CLI-Crash), Hinweis auf moegliches Feature-Update.

## [1.5.0] - 2026-09-29

### Hinzugefuegt
- Versionsanzeige in der App: aktuelle Version im Footer und im Info-Dialog sichtbar (/api/version-Endpunkt).
- Dieses Changelog.

### Behoben
- 3MF-Parser: Mesh-Geometrie (Volumen/Oberflaeche) wurde bei mehrteiligen Bambu Studio/OrcaSlicer-Exporten (Mesh in externen Objekt-Dateien statt in 3D/3dmodel.model) nicht gefunden - betraf die Skalierungs-Schaetzung.

### Hinweis
- Enthaelt zusaetzlich alle Stufe-2-Features (Filament-Skalierungs-Schaetzung: STL-Oberflaeche, 3MF-Mesh-Geometrie, Kalibrierungsmodell, Settings + UI), die zwischen v1.3.0 und diesem Release entstanden sind.

## [1.3.0] - 0a3a26a

### Hinzugefuegt
- Hinweis zu macOS-Docker-Berechtigungen im Info-Dialog (Docker Desktop File Sharing + macOS-Datenschutzfreigabe).

### Behoben
- Versteckte Dateien/Ordner (u. a. ._dateiname-AppleDouble-Sidecar-Dateien von macOS/Nextcloud-Sync) werden beim Scan nicht mehr als zusaetzliche, kaputte Modelle erkannt.

## [1.2.0] - a563e52

### Hinzugefuegt
- Neues Feature "Am PC oeffnen": oeffnet den Windows Explorer mit der Modelldatei markiert, ueber ein eigenes meshhub://-Protokoll und ein lokal installierbares PowerShell-Helferskript (kein Admin noetig).
- Downloadbares Helfer-Skript (meshhub-windows-helper.zip) direkt aus der App.
- Neuer Info-Dialog auf der Hauptseite: erklaert das neue Feature, was die App grundsaetzlich macht, und verlinkt das GitHub-Repository.
- DE/EN-Texte fuer das neue Feature und den Info-Dialog.

### Behoben
- Ueberlappende Header-Buttons ("Bibliotheken" / "Info").

## [1.1.0] - 3141f84

Rename project to 3D Mesh Hub, add DE/EN UI language toggle, fix thumbnail cache, add favicon.

## [1.0.0] - 647c1c6

Initial commit: 3D-Datei-Archiv.
