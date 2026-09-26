# 3D-Datei-Archiv

Lokale, selbst gehostete Webapp zur Verwaltung eines eigenen STL-/3MF-/OBJ-Archivs:
Vorschau der Datei inklusive automatisch ausgelesener und eigener Zusatzinfos,
freies Drehen und Zoomen im 3D-Viewer (Three.js), Ordnerübersicht mit
serverseitig gerenderten Thumbnails.

Läuft komplett lokal in Docker — keine Uploads, keine Cloud, keine Registrierung.

## Schnellstart

1. Docker Desktop installiert? Dann:
   ```
   cp .env.example .env
   ```
2. In `.env` den Pfad zu deinem 3D-Dateien-Ordner eintragen (`DATA_ROOT`).
   Windows-Pfade mit Forward-Slashes schreiben, z.B. `DATA_ROOT=D:/Druckdaten`.
3. Starten:
   ```
   docker compose up --build -d
   ```
   **Hinweis:** Das Image enthält jetzt zusätzlich Chromium (für die
   Thumbnail-Generierung) — der erste Build lädt entsprechend mehr herunter
   und das Image ist spürbar größer als vorher.
4. Im Browser öffnen: http://localhost:3000
5. Oben rechts auf **„Bibliotheken“** klicken und die gewünschten Unterordner
   innerhalb deines Datenordners als Bibliothek hinzufügen — pro Ordner mit
   Checkbox **„inkl. Unterordner“** steuerbar. Danach **„Neu scannen“**
   klicken.

Ändert sich `DATA_ROOT` später, einfach `.env` anpassen und
`docker compose up -d` erneut ausführen (kein Rebuild nötig für reine Pfadänderungen).

## Warum ein Ordner in der .env statt Auswahl direkt im Browser?

Ein laufender Docker-Container kann aus Sicherheitsgründen keinen beliebigen
Host-Ordner nachträglich einbinden. Deshalb: **einmalig** einen (ruhig
großzügig gewählten) Wurzelordner in `docker-compose.yml`/`.env` eintragen —
die eigentliche Auswahl, welche Unterordner als "Bibliothek" durchsucht
werden, läuft danach komplett über die Oberfläche (wie bei Jellyfin/Plex).

## Was wird aktuell unterstützt?

| Format | 3D-Vorschau | Thumbnail | Ausgelesene Metadaten |
|---|---|---|---|
| STL (ASCII + binär) | Ja | Ja (server-gerendert) | Dreieckszahl, Bounding Box, Näherungsvolumen |
| 3MF | Ja | Ja (server-gerendert) | Core-3MF-Metadaten (Titel/Ersteller/Anwendung etc.), erkennt vorhandene Slicer-Zusatzdateien |
| OBJ | Ja | Ja (server-gerendert) | Vertex-/Flächenzahl, Bounding Box (kein Volumen, da OBJ auch Nicht-Dreiecksflächen haben kann) |

STEP (CAD-B-Rep-Format, kein Dreiecksnetz) wird bewusst NICHT unterstützt: im
Hobby-/Community-3D-Druck-Bereich, für den dieses Archiv gedacht ist, wird
praktisch ausschließlich STL/3MF/OBJ verteilt — STEP ist ein reines
CAD-Quellformat und würde einen eigenen CAD-Kernel (z.B. OpenCascade) zur
Konvertierung erfordern, ohne dass ein Testfall dafür vorläge.

Zusätzlich gibt es pro Datei eigene, frei editierbare Felder: **Status**
(z.B. gedruckt/geplant), **Tags** und **Notizen** — unabhängig vom
Dateiformat, bleiben in einer separaten SQLite-Datenbank (eigenes
Docker-Volume) erhalten, auch nach einem Rescan.

## Oberfläche

- **Ordner-Ansicht** (Standard): Karten pro Ordner mit Thumbnail des ersten
  renderbaren Modells darin, Format-Badges, Datei-Anzahl, Gesamtgröße. Klick
  auf eine Karte drillt in die Dateien dieses Ordners.
- **Datei-Ansicht**: flache Liste aller gescannten Dateien, gleiche
  Such-/Sortier-Toolbar.
- Klick auf eine Datei öffnet ein Overlay mit 3D-Viewer, ausgelesenen
  Metadaten und dem eigenen Notizen/Tags/Status-Formular.
- Stat-Kacheln oben (Ordner, Dateien gesamt, STL/3MF/OBJ-Anzahl).
- Schwebende Anzeige unten rechts ("Vorschaubilder werden geladen… X/Y"), solange die
  sichtbaren Karten noch Thumbnails nachladen.

## Thumbnails: wie sie entstehen

Beim ersten Aufruf einer Datei-Kachel rendert ein headless Chromium
(Puppeteer, im Container installiert) das Modell einmalig auf einer internen
Seite (`public/render.html`) und speichert das Ergebnis als PNG im
`app-db`-Volume (`/app/db/thumbnails/`) — spätere Aufrufe liefern die gecachte
Datei direkt aus. Kein Massen-Rendering beim Scan (das würde bei großen
Archiven den Scan-Vorgang stark verlangsamen), sondern bedarfsgesteuert
("lazy") beim ersten Betrachten.

**Bekannte Stolperfalle (bereits gefixt):** Die erste Version lief auf
Alpine Linux und scheiterte mit `Error creating WebGL context` — Alpines
Chromium-Paket hat keine zuverlässige Software-WebGL-Unterstützung (SwiftShader)
für Headless-Rendering im Container. Seit diesem Fix läuft die Runtime auf
Debian (`node:20-slim`) mit expliziten Software-Rendering-Flags
(`--use-gl=swiftshader`, `--enable-unsafe-swiftshader`) sowie größerem
`/dev/shm` (`shm_size: 1gb` in der `docker-compose.yml`), da ein zu kleines
`/dev/shm` eine häufige zweite Absturzursache für Chromium in Containern ist.

Falls es trotzdem nicht rendert: `docker compose logs -f` zeigt die genaue
Fehlermeldung; `docker compose exec 3d-datei-archiv chromium --version`
prüft, ob das Binary überhaupt startet.

**Zweite Stolperfalle (ebenfalls gefixt):** Beim Umstieg auf Debian wurde
zunächst nur die Laufzeit-Stage umgestellt, die Build-Stage (in der
`better-sqlite3` nativ kompiliert wird) blieb auf Alpine — das native Binding
passte dann nicht zur glibc-Laufzeit (`libc.musl-x86_64.so.1: cannot open
shared object file`, Container-Crash-Loop direkt beim Start). Beide Stages
im Dockerfile nutzen jetzt durchgängig `node:20-slim`.

**Dritte Stolperfalle (Workaround, kein Docker-Problem):** Three.js' mitgelieferter
3MF-Loader kommt nicht mit mehrteiligen 3MF-Dateien zurecht (typisch für
Bambu Studio/OrcaSlicer, wenn Objekte in separaten Modell-Teilen liegen und
nur per Komponente referenziert werden) — Fehlerbild:
`Cannot read properties of undefined (reading 'mesh')`. Das ist eine bekannte
Einschränkung des Standard-Loaders selbst. `scripts/patch-3mfloader.js`
patcht das beim Docker-Build automatisch (sucht referenzierte Objekt-IDs in
allen Modell-Teilen statt nur im aktuellen). **Best effort:** Der Patch
prüft vor dem Anwenden, ob der erwartete Original-Code noch vorhanden ist,
und überspringt sich selbst mit einer Warnung im Build-Log, statt den Build
kaputtzumachen, falls eine spätere three.js-Version die interne Struktur
ändert. Falls nach dem Rebuild immer noch `reading 'mesh'`-Fehler auftauchen:
im Build-Log nach `3MFLoader-Patch` suchen, ob er angewendet wurde.

**Vierte Stolperfalle (ebenfalls gefixt):** `Waiting failed: ...ms exceeded` trat
wiederholt für dieselben Dateien bei jedem Seitenaufruf auf — Ursache war fehlende
Nebenläufigkeits-Begrenzung: eine Ordner-Ansicht mit vielen Karten fordert alle
Thumbnails gleichzeitig an, und Software-WebGL (SwiftShader) ist zu langsam, um das
parallel zu stemmen. Fix: `server/thumbnails.js` hat jetzt eine Warteschlange
(max. 2 gleichzeitige Renders), dedupt parallele Anfragen für dieselbe Datei, und
merkt sich gescheiterte Dateien für 10 Minuten statt sie bei jedem Aufruf erneut zu
versuchen.

**Sechste Stolperfalle (vollständig gefixt):** Bei großen Dateien (mehrere zehn MB)
konnte die Detail-Ansicht die Seite kurz komplett einfrieren (kein Scrollen/Klicken
möglich). Ursache: STL-/3MFLoader von three.js parsen synchron im Haupt-Thread des
Browsers. Fix: das Parsen läuft jetzt in einem Web Worker (`public/js/parse-worker.js`) -
der lädt die Datei, parst sie (ZIP/XML/Binärdaten -> Vertex-Arrays) und schickt nur die
fertigen Zahlen-Arrays per `postMessage` (als Transferable Objects, praktisch ohne
Kopierkosten) zurück an den Haupt-Thread, der daraus in Millisekunden die eigentlichen
Three.js-Objekte baut. Die Seite bleibt während des Ladens durchgehend bedienbar. Für
Server-Thumbnails greift ab 40 MB (Standard) weiterhin das Größenlimit (siehe unten) —
reale Testdaten zeigen, dass Software-Rendering (SwiftShader, kein Zugriff auf die
Host-GPU im Container) ab ~47 MB zuverlässig scheitert, auch mit hohem Timeout. Ein
optionaler GPU-Passthrough für Thumbnails (z.B. `/dev/dri` auf Linux-Hosts mit Intel/AMD-
iGPU) ist als späterer, opt-in Baustein vorgemerkt — funktioniert aber prinzipbedingt
nicht unter Windows/Mac mit Docker Desktop und muss beim Containerstart feststehen
(kein Laufzeit-Schalter im UI möglich).

**Wichtig für Diagnose:** Die Fehlermeldung im Log nennt jetzt den Dateipfad und die
Dateigröße, nicht mehr nur den internen Hash — bei `docker compose logs -f` siehst du
also direkt, welche Datei betroffen ist. Zusätzlich gibt es ein Größenlimit
(`THUMB_MAX_SIZE_MB`, Standard 150 MB): Dateien darüber bekommen sofort den
"Keine Vorschau verfügbar"-Platzhalter statt bei jedem Versuch erneut 45 Sekunden in den
Timeout zu laufen — Software-Rendering ohne Grafikkarte (SwiftShader) schafft sehr große/
komplexe Modelle in der Zeit oft schlicht nicht. Grenze in der `.env` anpassbar.

**Fünfte Stolperfalle (ebenfalls gefixt):** Der 3D-Viewer im Detail-Overlay
konnte über den Rahmen hinaus in den Text darunter überlaufen. Ursache: die
Containergröße wurde gemessen, während das Overlay noch unsichtbar
(`display:none`) war, was 0×0 ergab und den Viewer auf einen falschen
Fallback-Wert (480×360px) zurückfallen ließ. Fix: Reihenfolge im Frontend
korrigiert (Overlay wird zuerst sichtbar gemacht, danach erst gerendert),
eine zweite Neumessung nach dem nächsten Frame als Absicherung, und
`overflow:hidden` + erzwungene 100%-Canvasgröße per CSS als letztes
Sicherheitsnetz.

## Experimentell: GPU-Beschleunigung fuer Thumbnails testen

Standardmaessig rendert die App Thumbnails per Software (SwiftShader) - funktioniert
garantiert ueberall, ist aber bei grossen/komplexen Dateien irgendwann zu langsam (siehe
Größenlimit oben). Wer eine NVIDIA-GPU hat und unter Docker Desktop bereits GPU-Zugriff fuer
andere Container funktioniert (z.B. Frigate, andere CUDA-Workloads), kann echte
GPU-Beschleunigung testen:

1. In der `.env`: `GPU_ACCEL=true` setzen
2. Mit beiden Compose-Dateien starten:
   `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d`

**Ehrlich gesagt experimentell:** NVIDIA-GPU-Zugriff in Docker Desktop (WSL2) ist fuer
Video-Decoding/CUDA gut erprobt, aber ob dieselbe Anbindung genauso zuverlaessig fuer
echtes WebGL-Rendering durch Chromium funktioniert, ist deutlich weniger dokumentiert.
Deshalb: eigene Override-Datei statt Teil der normalen Konfiguration (ein System ohne
passende GPU wuerde mit `docker-compose.gpu.yml` gar nicht erst starten), und ein
automatischer Fallback auf Software-Rendering in `server/thumbnails.js`, falls der
GPU-Start von Chromium fehlschlaegt (siehe Log: "GPU-Start fehlgeschlagen, falle zurueck
auf Software-Rendering").

## Filament-Mengen-Erfassung

Im Detail-Formular kann pro Datei die benötigte Filamentmenge erfasst werden - als Liste
aus Farbe + Gramm (nicht nur eine Gesamtzahl), damit Mehrfarbdrucke korrekt abgebildet
werden können ("wie viel Rot brauche ich noch?"). Die Gesamtmenge wird automatisch als
Summe angezeigt. Mindestens eine Zeile bleibt immer stehen; leere Zeilen werden beim
Speichern ignoriert.

## Architektur (kurz)

- **Backend:** Node.js + Express, liest den read-only gemounteten Datenordner,
  serviert die REST-API und die statischen Frontend-Dateien.
- **Datenbank:** SQLite (better-sqlite3), im eigenen Docker-Volume
  `app-db` — getrennt vom Datenordner, damit nichts am eigenen Archiv
  verändert wird. Thumbnails liegen im selben Volume.
- **Frontend:** Vanilla JS + Three.js (STLLoader/3MFLoader + OrbitControls),
  keine Build-Pipeline nötig. Bewusst **kein** Druckbett-Gitter im Viewer — wir wissen
  nicht, wie der Ersteller das Objekt ausgerichtet hat, ein Gitter würde eine falsche
  "Unten"-Seite suggerieren.
- **Thumbnails:** Puppeteer-core + Chromium (per `apk` im Image), rendert
  `public/render.html` headless und liest das `<canvas>` als PNG aus.
- **Verteilung:** Ein Container pro Nutzer, läuft lokal bei jedem selbst
  (kein zentraler Server) — gedacht als quelloffenes Tool für alle, nicht nur
  für den eigenen Homelab-Gebrauch.

## Stand / Nächste Schritte

- [ ] Chromium/Puppeteer-Rendering im echten Container verifizieren
- [ ] Mehrstufige Ordner-Navigation (aktuell: eine Ebene, direkter Elternordner)
- [ ] Lizenz-Entscheidung (Vorschlag: MIT, analog zu Filament-Lager) + Repo auf
      Forgejo/GitHub anlegen
