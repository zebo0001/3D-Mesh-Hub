"""3D Mesh Hub - Stufe 2: Skalieren und Aufteilen nach Druckbettgroesse.

Ein geschlossenes Netz wird auf eine Zielhoehe skaliert und mit ebenen Schnitten
so lange geteilt, bis jedes Teil aufs Druckbett passt. Schnittstellen werden dort
gesucht, wo der Querschnitt klein ist (Hals, Taille, Handgelenke ...). Die Schnitte
sind exakt (Manifold), die Volumensumme der Teile entspricht dem Original.

Jedes Teil wird fertig fuer den Druck ausgerichtet (Z oben, moeglichst die
Schnittflaeche unten, auf Null verschoben) und als STL in eine ZIP-Datei gelegt.
"""
import io
import itertools
import json
import math
import os
import zipfile

import numpy as np
import trimesh
import manifold3d as m3

MIN_PIECE_MM = float(os.environ.get("MIN_PIECE_MM", "20"))   # kleinste erlaubte Teildicke an der Schnittstelle
SEARCH_WINDOW = float(os.environ.get("SEARCH_WINDOW", "0.12"))  # Suchfenster um die Idealposition (Anteil der Laenge)
SAMPLES = 41
MAX_PARTS = int(os.environ.get("MAX_PARTS", "200"))
SPLITTER_MM3 = 1000.0   # Teile kleiner als 1 cm3 werden als Splitter gemeldet

AXIS_NAMES = "xyz"
PERMS = list(itertools.permutations(range(3)))


class PlanError(ValueError):
    pass


# ---------------------------------------------------------------- Manifold-Helfer

def _to_manifold(mesh):
    m = m3.Manifold(m3.Mesh(
        vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
        tri_verts=np.asarray(mesh.faces, dtype=np.uint32),
    ))
    if m.status() != m3.Error.NoError:
        raise PlanError(f"Netz ist nicht geschlossen/sauber genug zum Schneiden ({m.status()}). Bitte zuerst reparieren.")
    return m


def _to_trimesh(M):
    mm = M.to_mesh()
    return trimesh.Trimesh(
        np.asarray(mm.vert_properties)[:, :3].astype(np.float64),
        np.asarray(mm.tri_verts).astype(np.int64),
        process=False,
    )


def _bounds(M):
    bb = M.bounding_box()
    arr = np.array(bb, dtype=float).reshape(-1)
    return arr[:3], arr[3:6]


def _axis_view(M, axis):
    """Kopie, deren Z-Koordinate der Originalachse `axis` entspricht (fuer Querschnitte)."""
    if axis == 2:
        return M
    if axis == 1:
        return M.rotate((90.0, 0.0, 0.0))
    return M.rotate((0.0, -90.0, 0.0))


# ---------------------------------------------------------------- Passen und Ausrichten

def _fitting_perms(ext, bed):
    """Alle Zuordnungen Teilachse -> Bettachse, bei denen das Teil passt."""
    return [p for p in PERMS if all(ext[p[i]] <= bed[i] + 1e-6 for i in range(3))]


def _worst_axis(ext, bed):
    """Teilachse, die am staerksten ueber das Bett hinausragt (bei bester Zuordnung)."""
    best = None
    for p in PERMS:
        ratios = [ext[p[i]] / bed[i] for i in range(3)]
        worst = max(ratios)
        if best is None or worst < best[0] - 1e-12:
            best = (worst, p, ratios)
    worst, p, ratios = best
    i = int(np.argmax(ratios))
    return p[i], ratios[i], bed[i]


def _pick_perm(ext, bed, faces, up_axis):
    """Beste Druckausrichtung unter allen passenden: Schnittflaeche unten, natuerliche Richtung, niedrig."""
    fits = _fitting_perms(ext, bed)
    if not fits:
        return None

    def flat_down(p):
        if not faces:
            return True
        return any(a == p[2] for a, _ in faces)

    fits.sort(key=lambda p: (0 if flat_down(p) else 1, 0 if p[2] == up_axis else 1, ext[p[2]]))
    return fits[0]


def _orient(mesh, p, faces):
    """Proper Rotation (keine Spiegelung): Bett-X<-p[0], Bett-Y<-p[1], Bett-Z<-p[2]; Schnittflaeche nach unten."""
    P = np.zeros((3, 3))
    for i in range(3):
        P[i, p[i]] = 1.0
    if np.linalg.det(P) < 0:
        P[1, :] *= -1.0
    up = p[2]
    has_min = any(a == up and s == "min" for a, s in faces)
    has_max = any(a == up and s == "max" for a, s in faces)
    flipped = False
    if has_max and not has_min:
        P = np.diag([1.0, -1.0, -1.0]) @ P   # 180 Grad um X
        flipped = True
    out = mesh.copy()
    out.vertices = out.vertices @ P.T
    out.vertices -= out.bounds[0]
    flat = (not faces) or has_min or has_max   # ungeschnittene Teile haben nichts abzulegen
    return out, flat, flipped


# ---------------------------------------------------------------- Schnittsuche

def _choose_cut(M, axis, lo, hi, n, limit):
    """Position (Koordinate entlang `axis`) mit kleinem Querschnitt nahe der Idealposition."""
    L = hi - lo
    k = n // 2
    ideal = lo + L * k / n
    w = SEARCH_WINDOW * L
    # beide Seiten muessen mit k bzw. n-k Abschnitten noch machbar bleiben
    feas_a = max(lo + MIN_PIECE_MM, hi - (n - k) * limit)
    feas_b = min(hi - MIN_PIECE_MM, lo + k * limit)
    if feas_a > feas_b:
        feas_a = feas_b = min(max(ideal, lo + MIN_PIECE_MM), hi - MIN_PIECE_MM)
    a = max(feas_a, ideal - w)
    b = min(feas_b, ideal + w)
    if a > b:
        a, b = feas_a, feas_b
    V = _axis_view(M, axis)
    best = None
    for s in np.linspace(a, b, SAMPLES):
        cs = V.slice(float(s))
        area = float(cs.area())
        contours = int(cs.num_contour())
        if area <= 0:
            continue
        dist = (s - ideal) / max(w, 1e-9)
        score = area * (1.0 + 0.15 * max(contours - 1, 0)) * (1.0 + 0.5 * dist * dist)
        if best is None or score < best[0]:
            best = (score, float(s), area, contours)
    if best is None:
        s = float(min(max(ideal, a), b))
        return s, 0.0, 0
    return best[1], best[2], best[3]



# ---------------------------------------------------------------- Anker (Teilezuordnung fuer feste Schnitte)

def _point_in_polys(pt, polys):
    """Even-Odd-Test ueber alle Konturen (Loecher werden dadurch beruecksichtigt)."""
    x, y = pt
    inside = False
    for poly in polys:
        p = np.asarray(poly, dtype=float)
        if len(p) < 3:
            continue
        x1, y1 = p[:, 0], p[:, 1]
        x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
        cond = (y1 > y) != (y2 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
        if np.count_nonzero(cond & (x < xin)) % 2 == 1:
            inside = not inside
    return inside


def _interior_point(cs):
    """Ein Punkt sicher im Inneren des Querschnitts (Ansichts-Koordinaten u,v)."""
    polys = [np.asarray(p, dtype=float) for p in cs.to_polygons()]
    polys = [p for p in polys if len(p) >= 3]
    if not polys:
        return None

    def area(p):
        x, y = p[:, 0], p[:, 1]
        return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))

    big = max(polys, key=lambda p: abs(area(p)))
    c = big.mean(axis=0)
    lo, hi = big.min(axis=0), big.max(axis=0)
    cands = [c]
    for fx in np.linspace(0.05, 0.95, 19):
        for fy in np.linspace(0.05, 0.95, 19):
            cands.append(lo + (hi - lo) * np.array([fx, fy]))
    cands.sort(key=lambda q: float(np.hypot(*(q - c))))
    for q in cands:
        if _point_in_polys(q, polys):
            return [round(float(q[0]), 3), round(float(q[1]), 3)]
    return None


def _contains_anchor(M, axis, pos, anchor):
    cs = _axis_view(M, axis).slice(float(pos))
    polys = [np.asarray(p, dtype=float) for p in cs.to_polygons()]
    return _point_in_polys(anchor, polys)


def _split_piece(M, faces, axis, pos):
    """Teilt ein Stueck an der Ebene; liefert Liste neuer (Manifold, Schnittflaechen)."""
    normal = [0.0, 0.0, 0.0]
    normal[axis] = 1.0
    above, below = M.split_by_plane(normal, pos)
    out = []
    for piece, side in ((below, "max"), (above, "min")):
        if piece.is_empty():
            continue
        for comp in piece.decompose():
            if comp.volume() <= 1e-6:
                continue
            clo, chi = _bounds(comp)
            nf = list(faces)
            touch = chi[axis] if side == "max" else clo[axis]
            if abs(touch - pos) < 1e-2:
                nf.append((axis, side))
            out.append((comp, nf))
    return out


def _fallback_perm(ext, bed):
    """Fuer Teile, die nicht passen: Zuordnung mit dem kleinsten Ueberstand."""
    return min(PERMS, key=lambda p: (max(ext[p[i]] / bed[i] for i in range(3)), ext[p[2]]))

# ---------------------------------------------------------------- Hauptfunktion

def split_mesh(path, params, progress=None):
    """Gibt (zip_bytes, report) zurueck."""
    def say(msg):
        if progress:
            progress(msg)

    say("Lade Datei")
    loaded = trimesh.load(path, force="mesh", process=True)
    if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
        raise PlanError("Die Datei enthaelt kein lesbares Dreiecksnetz")
    if not loaded.is_watertight:
        raise PlanError("Das Netz ist nicht geschlossen. Bitte zuerst 'Mesh prüfen und reparieren' ausfuehren.")

    ext0 = loaded.extents
    up_mode = str(params.get("up_axis", "auto")).lower()
    up = int(np.argmax(ext0)) if up_mode == "auto" else AXIS_NAMES.index(up_mode)
    # Richtung nur fuer die Nummerierung (unten zuerst); die Druckausrichtung haengt nicht davon ab.
    up_sign = -1.0 if params.get("up_flip") else 1.0

    if params.get("target_height_mm"):
        scale = float(params["target_height_mm"]) / float(ext0[up])
    else:
        scale = float(params.get("scale", 1.0))
    if not (scale > 0):
        raise PlanError("Ungueltiger Massstab")

    bed_in = params.get("bed") or {}
    margin = float(params.get("margin_mm", 10))
    bed = [float(bed_in.get(k, 0)) - 2 * margin for k in ("x", "y", "z")]
    if min(bed) < 30:
        raise PlanError("Druckbett abzueglich Rand ist zu klein")

    say("Skaliere")
    origin = loaded.bounds[0].copy()   # Dateikoordinate der Modellecke: Datei = origin + Position / scale
    loaded.apply_scale(scale)
    loaded.vertices -= loaded.bounds[0]
    volume_scaled = float(loaded.volume)
    M0 = _to_manifold(loaded)
    ext_scaled = [float(x) for x in loaded.extents]

    warnings = []
    manual = params.get("cuts")
    cuts = []
    if manual is None:
        work = [(M0, [])]
        done = []
        while work:
            M, faces = work.pop()
            lo_v, hi_v = _bounds(M)
            ext = hi_v - lo_v
            if _fitting_perms(ext, bed):
                done.append((M, faces))
                continue
            if len(done) + len(work) >= MAX_PARTS:
                raise PlanError(f"Mehr als {MAX_PARTS} Teile - Einstellungen pruefen (Zielhoehe, Druckbett)")
            axis, ratio, limit = _worst_axis(ext, bed)
            n = max(2, math.ceil(ratio - 1e-9))
            lo, hi = float(lo_v[axis]), float(hi_v[axis])
            say(f"Schnitt {len(cuts) + 1} ({len(done) + len(work) + 1} Teile)")
            pos, area, contours = _choose_cut(M, axis, lo, hi, n, limit)
            anchor = _interior_point(_axis_view(M, axis).slice(float(pos)))
            cuts.append({
                "axis": AXIS_NAMES[axis],
                "position_mm": round(pos, 2),
                "area_mm2": round(area, 1),
                "contours": contours,
                "part_extents_mm": [round(float(x), 1) for x in ext],
                "anchor": anchor,
                "region_mm": [round(float(x), 2) for x in list(lo_v) + list(hi_v)],
                "pieces_cut": 1,
            })
            for item in _split_piece(M, faces, axis, pos):
                work.append(item)
    else:
        if not isinstance(manual, list) or len(manual) > 60:
            raise PlanError("Ungueltige Schnittliste")
        done = [(M0, [])]
        for ci, c in enumerate(manual, 1):
            say(f"Schnitt {ci} von {len(manual)}")
            try:
                axis = AXIS_NAMES.index(str(c["axis"]).lower())
                pos = float(c["position_mm"])
            except (KeyError, ValueError, TypeError):
                raise PlanError(f"Schnitt {ci}: Achse oder Position ungueltig")
            anchor = c.get("anchor")
            region = c.get("region_mm")
            cand = []
            for idx, (M, faces) in enumerate(done):
                lo_v, hi_v = _bounds(M)
                if not (lo_v[axis] + 0.5 < pos < hi_v[axis] - 0.5):
                    continue
                cand.append(idx)
            sel = []
            if anchor and len(anchor) == 2:
                sel = [i for i in cand if _contains_anchor(done[i][0], axis, pos, anchor)]
            if not sel and region and len(region) == 6:
                for i in cand:
                    lo_v, hi_v = _bounds(done[i][0])
                    if all(min(hi_v[k], region[3 + k]) - max(lo_v[k], region[k]) > 1.0 for k in range(3)):
                        sel.append(i)
            if not sel and not anchor and not region:
                sel = cand
            area_sum, contours_sum, ext_first = 0.0, 0, None
            for i in sel:
                M, faces = done[i]
                cs = _axis_view(M, axis).slice(float(pos))
                area_sum += float(cs.area())
                contours_sum += int(cs.num_contour())
            if not sel:
                warnings.append(f"Schnitt {ci} ({AXIS_NAMES[axis]} = {pos:.1f} mm) trifft kein Teil und wurde ignoriert")
                cuts.append({"axis": AXIS_NAMES[axis], "position_mm": round(pos, 2), "area_mm2": 0.0,
                             "contours": 0, "part_extents_mm": [], "anchor": anchor, "region_mm": region,
                             "pieces_cut": 0})
                continue
            if len(done) + len(sel) > MAX_PARTS:
                raise PlanError(f"Mehr als {MAX_PARTS} Teile - Schnittliste pruefen")
            first_ext = _bounds(done[sel[0]][0])
            new_anchor = anchor
            if not (anchor and len(anchor) == 2 and _contains_anchor(done[sel[0]][0], axis, pos, anchor)):
                new_anchor = _interior_point(_axis_view(done[sel[0]][0], axis).slice(float(pos)))
            cuts.append({
                "axis": AXIS_NAMES[axis],
                "position_mm": round(pos, 2),
                "area_mm2": round(area_sum, 1),
                "contours": contours_sum,
                "part_extents_mm": [round(float(x), 1) for x in (first_ext[1] - first_ext[0])],
                "anchor": new_anchor,
                "region_mm": region,
                "pieces_cut": len(sel),
            })
            new_done = []
            for i, (M, faces) in enumerate(done):
                if i in sel:
                    new_done.extend(_split_piece(M, faces, axis, pos))
                else:
                    new_done.append((M, faces))
            done = new_done

    say("Richte Teile aus")
    parts = []
    for M, faces in done:
        lo_v, hi_v = _bounds(M)
        ext = hi_v - lo_v
        p = _pick_perm(ext, bed, faces, up)
        fits = p is not None
        if p is None:
            p = _fallback_perm(ext, bed)
        tm = _to_trimesh(M)
        oriented, flat, flipped = _orient(tm, p, faces)
        centroid = (lo_v + hi_v) / 2.0
        parts.append({
            "mesh": oriented,
            "volume": float(M.volume()),
            "sort": (round(up_sign * float(centroid[up]) / 10.0), float(centroid[0]), float(centroid[2 if up != 2 else 1])),
            "flat_cut_face_down": bool(flat),
            "turned_over": bool(flipped),
            "up_axis_original": AXIS_NAMES[p[2]],
            "fits": bool(fits),
            "bounds_mm": [round(float(x), 2) for x in list(lo_v) + list(hi_v)],
        })
    parts.sort(key=lambda d: d["sort"])

    zbuf = io.BytesIO()
    part_reports = []
    with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, d in enumerate(parts, 1):
            name = f"Teil-{i:02d}"
            data = trimesh.exchange.stl.export_stl(d["mesh"])
            zf.writestr(f"{name}.stl", data)
            e = [round(float(x), 1) for x in d["mesh"].extents]
            part_reports.append({
                "name": name,
                "extents_mm": e,
                "volume_cm3": round(d["volume"] / 1000.0, 1),
                "flat_cut_face_down": d["flat_cut_face_down"],
                "up_axis_original": d["up_axis_original"],
                "tiny": d["volume"] < SPLITTER_MM3,
                "fits": d["fits"],
                "bounds_mm": d["bounds_mm"],
            })
        vol_sum = sum(d["volume"] for d in parts)
        diff = abs(vol_sum - volume_scaled) / max(volume_scaled, 1.0)
        all_fit = all(
            all(sorted(r["extents_mm"])[i] <= sorted(bed)[i] + 0.2 for i in range(3)) for r in part_reports
        )
        if diff > 1e-4:
            warnings.append(f"Volumensumme weicht um {diff * 100:.3f} % vom Original ab - Ergebnis pruefen")
        tiny = sum(1 for r in part_reports if r["tiny"])
        if tiny:
            warnings.append(f"{tiny} sehr kleine Teile (unter 1 cm3) entstanden - Schnitte pruefen")
        nofit = sum(1 for r in part_reports if not r["fits"])
        if nofit:
            warnings.append(f"{nofit} Teile passen noch nicht aufs Druckbett - weitere Schnitte setzen")
        no_flat = sum(1 for r in part_reports if not r["flat_cut_face_down"])
        report = {
            "scale": round(scale, 5),
            "origin_mm": [round(float(x), 4) for x in origin],
            "manual": manual is not None,
            "up_axis": AXIS_NAMES[up],
            "up_axis_auto": up_mode == "auto",
            "up_flip": bool(params.get("up_flip")),
            "original_extents_mm": [round(float(x), 2) for x in ext0],
            "scaled_extents_mm": [round(x, 1) for x in ext_scaled],
            "bed_usable_mm": [round(x, 1) for x in bed],
            "margin_mm": margin,
            "parts": part_reports,
            "part_count": len(part_reports),
            "cuts": cuts,
            "checks": {
                "all_parts_fit": bool(all_fit),
                "volume_sum_diff_fraction": round(diff, 8),
                "parts_without_flat_face": no_flat,
            },
            "warnings": warnings,
        }
        zf.writestr("plan.json", json.dumps(report, ensure_ascii=False, indent=1))
    return zbuf.getvalue(), report
