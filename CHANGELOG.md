# Changelog

Alle nennenswerten Aenderungen an 3D Mesh Hub werden hier dokumentiert.
Das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/) (MAJOR.MINOR.PATCH).

## [Unreleased]

## [1.7.0] - 2026-10-21

### Hinzugefuegt
- "Kann ich das drucken?": Detailansicht einer 3MF gleicht die genutzten Farben/Materialien mit den Spulen des Lagersystems ab (Farbabstand + Materialfamilie) und zeigt je Farbe ok / zu wenig / keine passende Spule, inkl. gewaehlter Spule und Lagerort. Nur mit aktivierter Lager-Integration. Neuer Endpoint GET /api/files/:id/availability.
- 3MF-Parser liest Farbpalette, Materialtyp und genutzte Slots (extruder-Metadaten, einfache Mal-Farben-Codes) sowie echte Gramm aus geslicten Dateien (slice_info.config). Bestehende Dateien werden beim naechsten Scan nachgezogen.

- Ordner-Ansicht im Explorer-Stil: startet in der Wurzel, zeigt Unterordner und die Dateien des aktuellen Ordners, Klick auf einen Ordner geht hinein, ein Brotkrumen-Pfad fuehrt zurueck. Mit Suchbegriff wird im ganzen Baum gesucht. Die flache "Dateien"-Ansicht bleibt.

- Druckhistorie in der Detailansicht: zeigt, wie oft eine Datei laut Lagersystem gedruckt wurde, das durchschnittlich real verbrauchte Gewicht und das letzte Druckdatum. Zuordnung nur ueber den Namen (exakter Treffer oder "aehnlicher Name", unsichere Treffer sind gekennzeichnet). Neuer Endpoint GET /api/files/:id/prints.

- Wurzelordner: Du gibst einen oder mehrere Wurzelordner an, alles darunter (auch spaeter neue Unterordner) wird angezeigt - kein Abwaehlen einzelner Ordner. Der gesamte Datenordner ist als Wurzel waehlbar. Ein Ordner, der schon in einem Wurzelordner liegt, wird abgelehnt; ein neuer Wurzelordner ersetzt enthaltene alte Eintraege. 'Nur direkte Dateien' entfaellt.

- Kategorien und Tags: je Datei eine Kategorie (neues Feld, Spalte file_meta.category, wird automatisch angelegt) plus beliebig viele Tags. Filterleiste unter der Toolbar mit Kategorie-Auswahl und Tag-Chips (mehrere Tags = UND-Verknuepfung), Anzahl je Eintrag, 'Filter zuruecksetzen'. Filter und Suche (jetzt auch in Tags/Kategorie) gelten ueber den ganzen Baum. Karten zeigen Kategorie und bis zu 3 Tags; im Detail gibt es Vorschlaege aus vorhandenen Tags/Kategorien. Tags werden beim Speichern getrimmt und ohne Duplikate abgelegt.

- Einheiten-Pruefung: 3MF nennen ihre Einheit im Modell (wird jetzt ausgelesen, Standard mm, inch/cm/m werden umgerechnet), STL/OBJ tragen keine - dort wird mm nur angenommen und im Detail vermerkt. Bei unbekannter oder ungewoehnlicher Groesse (<5 oder >500 mm) kann die tatsaechliche Laenge der groessten Kante eingegeben werden; der Faktor wird je Datei gespeichert (file_meta.unit_scale, Endpoint PUT /api/files/:id/unit) und wirkt auf Masse, Volumen und Flaeche in der Detailansicht. Vorbereitung fuer die Messfunktion.

- 3D-Viewer: Punkt-zu-Punkt-Messung (zwei Punkte auf dem Modell anklicken, Abstand in mm; Ziehen dreht weiter wie gewohnt) und Schnittebene (Achse X/Y/Z, Position per Regler, umkehrbar; Schnittflaeche wird bei geschlossenen Netzen farbig gefuellt). Die Messung nutzt den Einheiten-Faktor der Datei. Messpunkte werden per Strahlverfolgung gesetzt - bei sehr grossen Modellen kann ein Klick kurz dauern.

### Geaendert
- Detailansicht zweispaltig (3D-Ansicht + Metadaten links, Formular + Schaetzung/Verfuegbarkeit/Historie rechts, einspaltig auf schmalen Bildschirmen) mit Glas-Look (Blur, halbtransparente Flaechen) fuer Detail-Overlay und Dialoge. Rein Layout/CSS.
- Scan nach Containerstart: unveraenderte Dateien (gleiche Groesse + Aenderungsdatum, bereits geparst) werden nicht mehr neu eingelesen, und der Hintergrund-Scan gibt dem Server nach jeder Datei den Event-Loop frei. Vorher war die App nach einem Neustart minutenlang nicht bedienbar. Beim ersten Start nach diesem Update werden 3MF-Dateien einmalig neu geparst (Farbinfo).

### Hinweis
- Gramm je Farbe sind nur bei geslicten 3MF exakt; sonst grobe Schaetzung (Wand+Infill, Anteil aus der Datei).

## [1.6.2] - 2026-10-10

### Behoben
- "Am PC oeffnen": Der Button fehlte, wenn DATA_ROOT in der .env mit Backslashes angegeben war (z.B. E:\\Nextcloud\\3d). Die Windows-Pfad-Erkennung akzeptiert jetzt Backslash und Schraegstrich.

## [1.6.1] - 2026-10-09

### Behoben
- 3D-Viewer: Bei mehrteiligen 3MF-Dateien (Bambu Studio/OrcaSlicer mit mehreren Objekten) lagen die Objekte uebereinander bzw. fehlten. Ursache: der three.js-3MFLoader legte Objekte nur nach nackter ID ab (in jeder Objekt-Datei heisst das Mesh id=1) und ignorierte p:path. scripts/patch-3mfloader.js loest Objekte jetzt je Modell-Datei auf. Bestehende Thumbnails/GLB-Caches werden durch RENDER_VERSION = 3 automatisch neu erzeugt.

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
