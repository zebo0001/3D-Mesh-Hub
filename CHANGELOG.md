# Changelog

Alle nennenswerten Änderungen an 3D Mesh Hub werden hier dokumentiert.
Das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/) (`MAJOR.MINOR.PATCH`).

## [1.4.0] - 2026-09-28

### Hinzugefügt
- Versionsanzeige in der App: aktuelle Version im Footer und im Info-Dialog sichtbar (`/api/version`-Endpunkt).
- Dieses Changelog.

## [1.3.0] - 0a3a26a

### Hinzugefügt
- Hinweis zu macOS-Docker-Berechtigungen im Info-Dialog (Docker Desktop File Sharing + macOS-Datenschutzfreigabe).

### Behoben
- Versteckte Dateien/Ordner (u. a. `._dateiname`-AppleDouble-Sidecar-Dateien von macOS/Nextcloud-Sync) werden beim Scan nicht mehr als zusätzliche, kaputte Modelle erkannt.

## [1.2.0] - a563e52

### Hinzugefügt
- Neues Feature "Am PC öffnen": öffnet den Windows Explorer mit der Modelldatei markiert, über ein eigenes `meshhub://`-Protokoll und ein lokal installierbares PowerShell-Helferskript (kein Admin nötig).
- Downloadbares Helfer-Skript (`meshhub-windows-helper.zip`) direkt aus der App.
- Neuer Info-Dialog auf der Hauptseite: erklärt das neue Feature, was die App grundsätzlich macht, und verlinkt das GitHub-Repository.
- DE/EN-Texte für das neue Feature und den Info-Dialog.

### Behoben
- Überlappende Header-Buttons ("Bibliotheken" / "Info").

## [1.1.0] - 3141f84

### Geändert
- Projekt umbenannt von "3D-Datei-Archiv" zu "3D Mesh Hub".
- Sprachumschalter DE/EN als eigenständige UI-Sprache (nicht nur Metadaten).

### Hinzugefügt
- Favicon (SVG/ICO/PNG) auf Basis des Würfel-Icons aus dem Header.

### Behoben
- Flaggen-Buttons (DE/GB) wurden unter Windows nur als Textboxen dargestellt (Emoji-Rendering-Problem) – jetzt als Inline-SVG-Flaggen.
- Thumbnail-Cache-Problem nach Umbenennung.

## [1.0.0] - 647c1c6

### Hinzugefügt
- Initiale Version: 3D-Datei-Archiv – self-hosted Docker-Webapp zur Verwaltung von STL/3MF/OBJ-3D-Druck-Dateiarchiven.
