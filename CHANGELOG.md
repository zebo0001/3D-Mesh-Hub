# Changelog

Alle nennenswerten Aenderungen an 3D Mesh Hub werden hier dokumentiert.
Das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/) (MAJOR.MINOR.PATCH).

## [1.14.0] - 2026-11-15

### Geaendert
- Aufteilen: Ein per Klick gesetzter Schnitt trennt nur die angeklickte zusammenhaengende Schnittflaeche (z. B. nur den Arm). Trifft die Ebene im selben Teil weitere Stellen des Koerpers, bleiben diese ungeschnitten und das Material wird wieder zusammengefuegt. Der Umriss im Viewer zeigt nur diese Flaeche.
- Duebel: je zusammenhaengender Schnittflaeche mindestens einer (z. B. beide Beine), bei grossen Flaechen mehrere (hoechstens 5, Abstand mindestens 3,2 Radien, Randabstand). In der ZIP liegt je Groesse eine `Duebel-NN.stl`, so oft drucken, wie Duebel eingeplant sind.
- Seitenbestimmung der Teile (fuer Duebellocher) jetzt ueber die Eckpunkte statt die Bounding-Box; bei schraegen Schnitten wurden Loecher sonst teils nicht gebohrt.

### Hinzugefuegt
- Schnitt-Editor: Druckerauswahl (Kobra X, Kobra 3 Max, andere, eigene Masse) mit Anzeige des nutzbaren Betts und Warnung, wie viele Teile nicht passen. Gilt fuer "Mit diesen Schnitten neu berechnen" und "Automatischen Vorschlag neu erzeugen".

## [1.13.1] - 2026-11-15

### Behoben
- Explosionsansicht: Fehlten die Vorschau-Dateien (Ergebnis aus einer aelteren Version), wurde das Original ausgeblendet und nichts angezeigt, ohne Meldung. Jetzt bleibt das Original sichtbar und es erscheint der Hinweis, neu zu berechnen.

## [1.13.0] - 2026-11-15

### Hinzugefuegt
- Aufteilen: Explosionsansicht im Schnitt-Editor. Jedes Teil bekommt eine Farbe, Regler "Abstand" zieht die Teile auseinander, die Teileliste (Farbe, Name, Masse, Volumen, Warnung bei Splittern) hebt beim Ueberfahren das Teil im Viewer hervor. Grundlage: die ZIP enthaelt zusaetzlich `vorschau/Teil-NN.stl` (zusammengebaute Lage), abrufbar ueber `GET /api/files/:id/split/preview/:n`. Aeltere Ergebnisse muessen neu berechnet werden.
- Duebel-Durchmesser pro Schnitt (Spalte "Duebel O": leer = automatisch, 0 = kein Duebel), nur bei eigener Schnittliste.
- Der Editor zoomt beim Oeffnen passend auf die Figur.

### Bekannt
- Der automatische Vorschlag kann weiterhin einen Kopf oder Koerper teilen, wenn das Teil breiter als das Bett ist; ein breiterer Suchbereich brachte in einem Test deutlich mehr Splitter und wurde verworfen. Empfehlung: Schnitt loeschen und Armschnitte selbst ziehen.

## [1.12.0] - 2026-11-15

### Hinzugefuegt
- Aufteilen: freie (schraege) Schnitte. "Schnittlinie ziehen": zwei Klicks auf die Figur, die Ebene geht durch die Linie in Blickrichtung und trifft nur das angeklickte Teil (STL-Buddy-Prinzip). Liegt die Ebene bis auf 4 Grad an einer Achse, wird sie zum Achsschnitt. Im Planer neuer Schnitttyp `free` mit `normal` und Versatz.
- Teile mit schraeger Schnittflaeche werden mit der Flaeche nach unten gedreht und um Z gedreht, bis sie aufs Bett passen.
- Duebel: an jedem Schnitt Loch in beiden Teilen (Sitz mit festem Spiel in mm, nicht mitskaliert) und ein loser Duebel als STL in der ZIP. Durchmesser automatisch (halber Abstand zum Rand, hoechstens 12 mm) oder fest, Tiefe und Spiel einstellbar. Im Viewer gruen dargestellt. Ungetestet im Druck.
- Viewer: Schnittumriss (exakter Querschnitt) statt grosser Platte, sobald berechnet.
- Planer meldet pro Schnitt den Querschnitt (`section`) und die Duebel (`connectors`); die Volumenpruefung rechnet die Loecher ein.

## [1.11.1] - 2026-11-15

### Hinzugefuegt
- Aufteilen: Schnitte einzeichnen. "Schnitt einzeichnen" (waagerecht/senkrecht je Achse) und das Fadenkreuz pro Zeile setzen einen Schnitt per Klick auf die Figur im 3D-Viewer. Der Klickpunkt (`near`) bestimmt, welches Teil geschnitten wird: nur das angeklickte, nicht jedes Teil, das die Ebene kreuzt. Esc bricht das Einzeichnen ab.

## [1.11.0] - 2026-11-15

### Hinzugefuegt
- Aufteilen: Schnitte bearbeiten. Der automatische Vorschlag liefert eine Schnittliste (Achse, Position in mm ab Modellecke); Positionen lassen sich aendern (Eingabe, +/-5 mm), Schnitte entfernen oder hinzufuegen, dann "Mit diesen Schnitten neu berechnen". Der Planer nimmt dafuer den Parameter `cuts` an und meldet pro Schnitt Anker, Bereich und wie viele Teile er getroffen hat; Schnitte ohne Treffer werden ignoriert und gemeldet.
- Schnittebenen als durchsichtige Platten im 3D-Viewer (aktiver Schnitt gelb), dazu ein Vollbild-"Schnitt-Editor" mit der Schnittliste als Seitenleiste (Schliessen mit Esc).
- Teile, die noch nicht aufs Druckbett passen, werden markiert statt den Lauf abzubrechen.

## [1.10.0] - 2026-11-13

### Hinzugefuegt
- Aufteilen fuer den Druck (STL/OBJ, setzt den optionalen Mesh-Dienst voraus): Modell auf eine Zielhoehe skalieren und mit ebenen Schnitten teilen, bis jedes Teil aufs Druckbett passt. Druckbett aus den Viewer-Profilen (z.B. Kobra X, Kobra 3 Max) oder eigene Masze, einstellbarer Rand (Standard 10 mm), Zielhoehe, Umkehr der Oben/Unten-Nummerierung.
- Schnittstellen werden dort vorgeschlagen, wo der Querschnitt klein ist (Hals, Taille, Gelenke) und beide Seiten noch machbar bleiben. Ergebnis: ZIP mit einer druckfertig ausgerichteten STL je Teil (Z oben, Schnittflaeche moeglichst unten) plus `plan.json`.
- Eingebaute Pruefungen: Volumensumme der Teile gegen das Original, jedes Teil passt aufs Bett, Warnung bei winzigen Splittern. Das Aufteilen nimmt automatisch die reparierte Kopie, nicht geschlossene Netze werden mit Hinweis abgelehnt.
- Noch nicht enthalten: Verbinder (Duebel/Zapfen/Rohrkanal), manuelles Verschieben der Schnittebenen im Viewer, 3MF mit Verteilung auf mehrere Druckbetten.

### Behoben
- `mesh-service/Dockerfile` kopiert jetzt auch `planner.py` ins Image.

## [1.9.1] - 2026-11-13

### Behoben
- Schnittebene: Die Positionsanzeige hat jetzt feste Breite. Vorher aenderte sich ihre Laenge beim Ziehen, die Werkzeugleiste brach um, das Layout sprang und der Regler wanderte unter dem Mauszeiger weg (Zittern, Sprung auf 100 %).
- Mesh-Box: Knoepfe und Download-Link sind jetzt gestaltet.
- Mesh-Reparatur: Der Mesh-Dienst blockierte waehrend der Reparatur (die C++-Reparatur haelt die Python-GIL) und der Hub brach mit "This operation was aborted" ab. Die Reparatur laeuft jetzt in einem eigenen Prozess, der Status antwortet jederzeit; einzelne Aussetzer beim Abfragen beenden den Job nicht mehr.
- Schnittebene: Beim Verschieben des Reglers wurde bei jedem Schritt der Shader neu kompiliert (Zittern, Springen bei grossen Modellen). Das passiert nur noch beim Ein-/Ausschalten, Regler-Ereignisse werden pro Bild gebuendelt.

## [1.9.0] - 2026-11-12

### Hinzugefuegt
- Mesh-Reparatur fuer STL und OBJ: In der Detailansicht prueft und repariert ein optionaler Python-Dienst (`mesh-service`) Loecher, fehlerhafte Kanten und winzige Splitter und legt eine reparierte Kopie ab. Vorher/Nachher-Bericht (geschlossen, Dreiecke, offene Kanten, Volumen), Download der reparierten STL. Die Originaldatei bleibt unveraendert.
- Opt-in ueber `docker-compose.mesh.yml` (setzt `MESH_SERVICE_URL`). Ohne diesen Dienst bleibt die Funktion ausgeblendet.

## [1.8.0] - 2026-11-01

### Geaendert
- Detailansicht: nur noch ein Scrollbalken (der innere Scrollbereich der rechten Spalte entfaellt).

### Hinzugefuegt
- 3D-Ansicht: Ansichten-Leiste (ISO / Drauf / Vorne / Seite), Darstellung Solid / Gitter / Glanz, Materialfarbe umschaltbar (bei mehrfarbigen Modellen stattdessen Anzeige der erkannten Farben).
- Druckbett ein-/ausblendbar mit Profilen (u.a. Kobra X 260x260x260, Kobra 3 Max 420x420x500) und Passt-Check (Drehung um 90 Grad erlaubt). Gewaehltes Profil wird im Browser gemerkt.
- Detailansicht: Kostenkarte in der Seitenleiste mit Material, Infill und Preis pro kg. Eingetragene Filamentmenge (Slicer/manuell) hat Vorrang, sonst Schnellschaetzung: Huelle (Oberflaeche x Wandstaerke aus den Einstellungen) voll plus Infill im Restvolumen, x Dichte (Richtwert). Start-Infill kommt aus den Einstellungen, solange im Browser keiner gemerkt ist.
- 3MF-Thumbnails: Ist ein Slicer-Vorschaubild eingebettet (Metadata/plate_1.png u.ae., Bambu/Orca/Prusa), wird es statt des Chromium-Renders verwendet (schneller, echte Farben). Zeigt die ganze Platte; fuer solche Dateien entsteht kein GLB-Cache (Viewer parst live). RENDER_VERSION = 4, Thumbnails werden einmalig neu erzeugt. Masse/Volumen/Dreiecke/Oberflaeche als Karten.
- Inspiriert von STLDepot (Schello805, CC BY-NC 4.0) - nur Ideen/Bedienkonzept, kein Code uebernommen.

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
