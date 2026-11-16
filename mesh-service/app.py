# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Zebo0001 (siehe LICENSE und NOTICE; nutzt pymeshfix, GPL-3.0)
"""3D Mesh Hub - Mesh-Dienst (Stufe 1: Reparatur).

Interner Helfer-Container, nur ueber docker-compose.mesh.yml aktiviert und
nicht nach aussen veroeffentlicht. Nimmt ein Modell (STL/OBJ) entgegen,
repariert es in einem Hintergrundjob und liefert Bericht + reparierte Datei.

Die Originaldatei wird nie veraendert: Der Dienst sieht nur eine Kopie, die
der Hub per HTTP schickt, und gibt das Ergebnis als neue STL zurueck.

Endpunkte:
  GET  /health
  POST /jobs            multipart: model (Datei), modelFilename (optional),
                        kind ("repair" oder "split", Standard repair),
                        params (JSON, nur fuer split, siehe planner.py)
                        -> {ok, job_id}
  GET  /jobs/{id}       -> {ok, state: queued|running|done|error, report?, error?}
  GET  /jobs/{id}/result  -> reparierte STL (repair) bzw. ZIP mit Teilen (split)
"""
import json
import multiprocessing
import os
import tempfile
import threading
import time
import uuid

import numpy as np
import pymeshfix
import trimesh

import planner
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

SERVICE_NAME = "3d-mesh-hub-mesh-service"
# Obergrenze fuer die Eingabe (Dreiecke). Schuetzt vor Speicherueberlauf; die
# Testdatei mit 828 000 Dreiecken lief problemlos.
# Darueber wird nicht abgelehnt, sondern automatisch vereinfacht (siehe AUTO_TARGET_FACES).
MAX_FACES = int(os.environ.get("MAX_FACES", "5000000"))
# Zielgroesse der automatischen Vereinfachung fuer zu grosse Dateien.
AUTO_TARGET_FACES = int(os.environ.get("AUTO_TARGET_FACES", "1500000"))
# Harte Obergrenze: noch groessere Dateien werden abgelehnt (Speicherschutz).
HARD_MAX_FACES = int(os.environ.get("HARD_MAX_FACES", "20000000"))
MIN_TARGET_FACES = 5000
# Fertige Jobs werden nach dieser Zeit samt Ergebnisdatei geloescht.
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", "3600"))
# Splitter: Komponenten mit weniger Dreiecken UND winziger Ausdehnung werden entfernt.
FRAGMENT_MAX_FACES = int(os.environ.get("FRAGMENT_MAX_FACES", "100"))
FRAGMENT_MAX_DIAG_FRACTION = float(os.environ.get("FRAGMENT_MAX_DIAG_FRACTION", "0.01"))
# Abweichung des Volumens, ab der ein Warnhinweis erscheint.
VOLUME_WARN_FRACTION = 0.02

SUPPORTED_EXT = {".stl", ".obj"}

app = FastAPI(title=SERVICE_NAME)

_jobs = {}
_jobs_lock = threading.Lock()


def _edge_stats(mesh):
    """Offene Kanten (nur 1 Flaeche) und nicht-manifold Kanten (>2 Flaechen)."""
    edges = mesh.edges_sorted
    if len(edges) == 0:
        return 0, 0
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int((counts == 1).sum()), int((counts > 2).sum())


def _describe(mesh):
    open_edges, nonmanifold = _edge_stats(mesh)
    try:
        volume = float(mesh.volume)
    except Exception:
        volume = None
    return {
        "faces": int(len(mesh.faces)),
        "vertices": int(len(mesh.vertices)),
        "watertight": bool(mesh.is_watertight),
        "open_edges": open_edges,
        "nonmanifold_edges": nonmanifold,
        "volume_mm3": volume,
        "extents_mm": [round(float(x), 3) for x in mesh.extents],
    }


def _split_components(mesh):
    return mesh.split(only_watertight=False)


def _repair_one(component):
    """pymeshfix auf einer einzelnen Komponente. Gibt ein neues Trimesh zurueck."""
    fixer = pymeshfix.MeshFix(np.asarray(component.vertices), np.asarray(component.faces))
    fixer.repair()
    return trimesh.Trimesh(np.asarray(fixer.points), np.asarray(fixer.faces), process=True)


def repair_mesh(path, progress=None, params=None):
    """Laedt, bereinigt und repariert. Gibt (reparierte Trimesh, Bericht) zurueck."""
    def say(msg):
        if progress:
            progress(msg)

    say("Lade Datei")
    loaded = trimesh.load(path, force="mesh", process=True)
    if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
        raise ValueError("Die Datei enthaelt kein lesbares Dreiecksnetz")
    if len(loaded.faces) > HARD_MAX_FACES:
        raise ValueError(f"Zu viele Dreiecke ({len(loaded.faces)}), absolutes Limit {HARD_MAX_FACES}")

    before = _describe(loaded)
    warnings = []

    # Optionale Vereinfachung (Quadric Decimation) vor der Reparatur.
    faces_in = len(loaded.faces)
    target = None
    try:
        if (params or {}).get("target_faces"):
            target = max(MIN_TARGET_FACES, int(params["target_faces"]))
    except (TypeError, ValueError):
        target = None
    auto = False
    if target is None and faces_in > MAX_FACES:
        target, auto = AUTO_TARGET_FACES, True
    if target is not None and faces_in > target:
        say(f"Vereinfache {faces_in:,} auf ca. {target:,} Dreiecke".replace(",", "."))
        loaded = loaded.simplify_quadric_decimation(face_count=target)
        loaded.process(validate=True)
        if len(loaded.faces) == 0:
            raise ValueError("Die Vereinfachung hat kein Netz uebrig gelassen")
        warnings.append(
            f"{'Automatisch ' if auto else ''}vereinfacht: {faces_in} -> {len(loaded.faces)} Dreiecke"
            + (f" (Datei lag ueber {MAX_FACES})" if auto else "")
            + ". Feine Details koennen leicht abgerundet sein."
        )
    simplified_from = faces_in if len(loaded.faces) < faces_in else None

    say("Analysiere Komponenten")
    components = _split_components(loaded)
    before["components"] = len(components)

    diag = float(np.linalg.norm(loaded.extents)) or 1.0
    kept, removed = [], 0
    for c in components:
        tiny = len(c.faces) < FRAGMENT_MAX_FACES and float(np.linalg.norm(c.extents)) < diag * FRAGMENT_MAX_DIAG_FRACTION
        if tiny and len(components) > 1:
            removed += 1
        else:
            kept.append(c)
    if not kept:  # Sicherheitsnetz: nie alles wegwerfen
        kept = [max(components, key=lambda c: len(c.faces))]

    repaired_parts, still_open = [], 0
    for i, c in enumerate(kept, 1):
        say(f"Repariere Teil {i} von {len(kept)}")
        if c.is_watertight and c.is_winding_consistent:
            repaired_parts.append(c)
            continue
        fixed = _repair_one(c)
        if not fixed.is_watertight:
            still_open += 1
        repaired_parts.append(fixed)

    result = repaired_parts[0] if len(repaired_parts) == 1 else trimesh.util.concatenate(repaired_parts)
    after = _describe(result)
    after["components"] = len(repaired_parts)

    if after["volume_mm3"] and before["volume_mm3"]:
        diff = abs(after["volume_mm3"] - before["volume_mm3"]) / max(abs(before["volume_mm3"]), 1.0)
        if diff > VOLUME_WARN_FRACTION:
            warnings.append(f"Volumen hat sich um {diff * 100:.1f} % geaendert - Ergebnis pruefen")
    if still_open:
        warnings.append(f"{still_open} Teil(e) blieben nach der Reparatur offen")

    report = {
        "before": before,
        "after": after,
        "removed_fragments": removed,
        "simplified_from": simplified_from,
        "warnings": warnings,
        "ok_watertight": bool(after["watertight"]),
    }
    return result, report


def _child_main(src_path, out_path, progress_path, report_path, kind="repair", params=None):
    """Laeuft in einem eigenen Prozess. pymeshfix ist C++ und gibt die Python-GIL
    nicht frei; in einem Thread wuerde es den Webserver waehrend der Reparatur
    komplett blockieren (Status-Abfragen laufen dann in ein Timeout)."""
    def progress(msg):
        try:
            with open(progress_path, "w", encoding="utf-8") as fh:
                fh.write(msg)
        except OSError:
            pass

    started = time.time()
    try:
        if kind == "split":
            data, report = planner.split_mesh(src_path, params or {}, progress)
            progress("Schreibe Ergebnis")
            with open(out_path, "wb") as fh:
                fh.write(data)
        else:
            mesh, report = repair_mesh(src_path, progress, params)
            progress("Schreibe Ergebnis")
            mesh.export(out_path, file_type="stl")
        report["seconds"] = round(time.time() - started, 1)
        payload = {"ok": True, "report": report}
    except Exception as exc:  # Fehlertext an den Hub durchreichen
        payload = {"ok": False, "error": str(exc) or exc.__class__.__name__}
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def _run_job(job_id, src_path, ext, kind="repair", params=None):
    """Ueberwacht den Reparatur-Prozess (leichter Thread, haelt die GIL nicht)."""
    job = _jobs[job_id]
    job["state"] = "running"
    out_path = src_path + ("_teile.zip" if kind == "split" else "_repariert.stl")
    progress_path = src_path + ".progress"
    report_path = src_path + ".report.json"
    try:
        ctx = multiprocessing.get_context("spawn")
        proc = ctx.Process(target=_child_main, args=(src_path, out_path, progress_path, report_path, kind, params), daemon=True)
        proc.start()
        while proc.is_alive():
            msg = _read_text(progress_path)
            if msg:
                job["progress"] = msg
            proc.join(timeout=0.5)
        proc.join()

        raw = _read_text(report_path)
        if raw is None:
            job["error"] = (
                f"Reparatur-Prozess unerwartet beendet (Exit-Code {proc.exitcode}); "
                "vermutlich zu wenig Arbeitsspeicher fuer diese Datei"
            )
            job["state"] = "error"
        else:
            payload = json.loads(raw)
            if payload.get("ok"):
                job["report"] = payload["report"]
                job["result_path"] = out_path
                job["state"] = "done"
            else:
                job["error"] = payload.get("error") or "Unbekannter Fehler"
                job["state"] = "error"
    except Exception as exc:
        job["error"] = str(exc) or exc.__class__.__name__
        job["state"] = "error"
    finally:
        for path in (src_path, progress_path, report_path):
            try:
                os.remove(path)
            except OSError:
                pass
        if job.get("state") != "done":
            try:
                os.remove(out_path)
            except OSError:
                pass
        job["finished"] = time.time()


def _cleanup_old_jobs():
    now = time.time()
    with _jobs_lock:
        for jid in [j for j, v in _jobs.items() if v.get("finished") and now - v["finished"] > JOB_TTL_SECONDS]:
            path = _jobs[jid].get("result_path")
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass
            del _jobs[jid]


@app.get("/health")
def health():
    return {"ok": True, "service": SERVICE_NAME}


@app.post("/jobs")
async def create_job(model: UploadFile = File(...), modelFilename: str = Form(default=""), kind: str = Form(default="repair"), params: str = Form(default="")):
    _cleanup_old_jobs()
    name = modelFilename or model.filename or "model.stl"
    ext = os.path.splitext(name)[1].lower()
    if ext not in SUPPORTED_EXT:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": f"Format {ext or '?'} wird in dieser Stufe nicht unterstuetzt (STL und OBJ)"},
        )
    if kind not in ("repair", "split"):
        return JSONResponse(status_code=400, content={"ok": False, "error": f"Unbekannte Auftragsart '{kind}'"})
    try:
        job_params = json.loads(params) if params else {}
        if not isinstance(job_params, dict):
            raise ValueError("kein Objekt")
    except ValueError:
        return JSONResponse(status_code=400, content={"ok": False, "error": "Parameter sind kein gueltiges JSON-Objekt"})
    fd, tmp_path = tempfile.mkstemp(suffix=ext, prefix="mesh_")
    with os.fdopen(fd, "wb") as fh:
        while True:
            chunk = await model.read(1024 * 1024)
            if not chunk:
                break
            fh.write(chunk)
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"state": "queued", "created": time.time(), "progress": "In Warteschlange", "filename": name, "kind": kind}
    threading.Thread(target=_run_job, args=(job_id, tmp_path, ext, kind, job_params), daemon=True).start()
    return {"ok": True, "job_id": job_id}


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job unbekannt oder abgelaufen")
    body = {"ok": True, "state": job["state"], "progress": job.get("progress")}
    if job["state"] == "done":
        body["report"] = job["report"]
    if job["state"] == "error":
        body["error"] = job.get("error")
    return body


@app.get("/jobs/{job_id}/result")
def job_result(job_id: str):
    job = _jobs.get(job_id)
    if not job or job.get("state") != "done":
        raise HTTPException(status_code=404, detail="Ergebnis nicht verfuegbar")
    if job.get("kind") == "split":
        return FileResponse(job["result_path"], media_type="application/zip", filename="teile.zip")
    return FileResponse(job["result_path"], media_type="model/stl", filename="repariert.stl")
