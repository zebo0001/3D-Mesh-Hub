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


def _view_uv(axis, p):
    """Punkt (x,y,z) in die 2D-Koordinaten von _axis_view(M, axis) umrechnen."""
    x, y, z = float(p[0]), float(p[1]), float(p[2])
    if axis == 2:
        return (x, y)
    if axis == 1:
        return (x, -z)
    return (-z, y)


def _dist_to_slice(M, axis, pos, point):
    """Abstand eines Punktes (in der Schnittebene betrachtet) zum Querschnitt; 0 wenn innen."""
    cs = _axis_view(M, axis).slice(float(pos))
    polys = [np.asarray(p, dtype=float) for p in cs.to_polygons() if len(p) >= 3]
    if not polys:
        return float("inf")
    q = np.array(_view_uv(axis, point), dtype=float)
    if _point_in_polys(q, polys):
        return 0.0
    best = float("inf")
    for p in polys:
        a, b = p, np.roll(p, -1, axis=0)
        ab = b - a
        denom = np.maximum((ab * ab).sum(axis=1), 1e-12)
        t = np.clip(((q - a) * ab).sum(axis=1) / denom, 0.0, 1.0)
        d = np.hypot(*(a + ab * t[:, None] - q).T)
        best = min(best, float(d.min()))
    return best


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



# ---------------------------------------------------------------- Freie Schnittebenen (beliebige Richtung)

def _unit(v):
    v = np.asarray(v, dtype=float)
    n = float(np.linalg.norm(v))
    if not (n > 1e-9):
        raise PlanError("Schnittebene: Normale ungueltig")
    return v / n


def _rot_to_z(n):
    """Drehmatrix R (3x3) mit R @ n = (0, 0, 1)."""
    n = _unit(n)
    z = np.array([0.0, 0.0, 1.0])
    c = float(np.dot(n, z))
    if c > 1.0 - 1e-12:
        return np.eye(3)
    if c < -1.0 + 1e-12:
        return np.diag([1.0, -1.0, -1.0])
    v = np.cross(n, z)
    s = float(np.linalg.norm(v))
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))


def _free_view(M, R):
    return M.transform(np.hstack([R, np.zeros((3, 1))]))


def _slice_free(M, R, d):
    return _free_view(M, R).slice(float(d))


def _polys_of(cs):
    return [np.asarray(p, dtype=float) for p in cs.to_polygons() if len(p) >= 3]


def _dist_to_polys(q, polys):
    if not polys:
        return float("inf")
    if _point_in_polys(q, polys):
        return 0.0
    best = float("inf")
    for p in polys:
        a, b = p, np.roll(p, -1, axis=0)
        ab = b - a
        denom = np.maximum((ab * ab).sum(axis=1), 1e-12)
        t = np.clip(((q - a) * ab).sum(axis=1) / denom, 0.0, 1.0)
        best = min(best, float(np.hypot(*(a + ab * t[:, None] - q).T).min()))
    return best


def _dist_free(M, R, d, point):
    q = (R @ np.asarray(point, dtype=float))[:2]
    return _dist_to_polys(q, _polys_of(_slice_free(M, R, d)))


def _crosses(M, n, d, tol=0.5):
    lo, hi = _bounds(M)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    sd = corners @ n - d
    return bool(sd.min() < -tol and sd.max() > tol)


def _decimate(p, limit=240):
    if len(p) <= limit:
        return p
    idx = np.linspace(0, len(p) - 1, limit).astype(int)
    return p[idx]


def _section_polys(M, spec):
    """Querschnitt als 2D-Konturen plus Abbildung (u,v) -> 3D (skalierte Koordinaten)."""
    if spec[0] == "axis":
        axis, pos = spec[1], spec[2]
        polys = _polys_of(_axis_view(M, axis).slice(float(pos)))

        def to3(u, v):
            if axis == 2:
                return (u, v, pos)
            if axis == 1:
                return (u, pos, -v)
            return (pos, v, -u)
    else:
        R, d = spec[1], spec[2]
        polys = _polys_of(_slice_free(M, R, d))
        Rt = R.T

        def to3(u, v):
            return tuple(Rt @ np.array([u, v, d]))
    return polys, to3


def _section_3d(M, spec):
    """Konturen des Querschnitts als 3D-Polygone fuer die Anzeige."""
    polys, to3 = _section_polys(M, spec)
    return [[[round(float(c), 2) for c in to3(u, v)] for u, v in _decimate(p)] for p in polys]


def _cut_cfg(cfg, dowel_mm):
    """Einstellungen fuer einen Schnitt: dowel_mm None = global, 0 = kein Duebel, >0 = fester Durchmesser."""
    if dowel_mm is None:
        return cfg
    c = dict(cfg)
    if float(dowel_mm) <= 0:
        c["enabled"] = False
    else:
        c["enabled"] = True
        c["diameter_mm"] = float(dowel_mm)
    return c


def _connect(first, spec, n, d, children, cfg, report_extra):
    """Duebel planen und Loecher bohren. Liefert (Kinder, entferntes Volumen, Verbinder|None, Warnung|None)."""
    if not cfg.get("enabled"):
        return children, 0.0, None, None
    polys, to3 = _section_polys(first, spec)
    plan, why = _plan_dowel(first, polys, n, d, lambda q: to3(q[0], q[1]), cfg)
    if plan is None:
        return children, 0.0, None, why
    clearance = float(cfg.get("clearance_mm", 0.3))
    kids, removed = _punch(children, n, d, plan, clearance)
    conn = {
        "center_mm": [round(x, 2) for x in plan["center"]],
        "normal": [round(float(x), 5) for x in n],
        "diameter_mm": round(plan["radius"] * 2, 2),
        "hole_diameter_mm": round(plan["radius"] * 2 + clearance, 2),
        "depth_mm": round(plan["depth"], 1),
        "dowel_length_mm": round(2 * plan["depth"] - 1.5, 1),
        "clearance_mm": clearance,
    }
    conn.update(report_extra)
    return kids, removed, conn, None


def _split_free(M, faces, n, d):
    above, below = M.split_by_plane([float(x) for x in n], float(d))
    out = []
    for piece, sign in ((below, 1.0), (above, -1.0)):
        if piece.is_empty():
            continue
        for comp in piece.decompose():
            if comp.volume() <= 1e-6:
                continue
            outward = tuple(float(x) for x in (sign * n))
            out.append((comp, list(faces) + [("n", outward, float(d) * sign)]))
    return out


def _orient_free(tm, M, faces, bed):
    """Teil mit schraeger Schnittflaeche: Flaeche nach unten, um Z drehen bis es aufs Bett passt."""
    scored = []
    lo_v, hi_v = _bounds(M)
    for f in faces:
        if f[0] == "n":
            _, o, d_out = f
            try:
                area = float(_slice_free(M, _rot_to_z(o), d_out - 0.05).area())
            except Exception:
                area = 0.0
            scored.append((area, np.asarray(o, dtype=float)))
        else:
            a, side = f
            o = np.zeros(3)
            o[a] = 1.0 if side == "max" else -1.0
            at = (hi_v[a] - 0.05) if side == "max" else (lo_v[a] + 0.05)
            try:
                area = float(_axis_view(M, a).slice(float(at)).area())
            except Exception:
                area = 0.0
            scored.append((area, o))
    scored.sort(key=lambda t: -t[0])
    best = None
    for _, o in scored:
        R = _rot_to_z(-np.asarray(o))      # o -> -Z (Schnittflaeche unten)
        V = tm.vertices @ R.T
        for deg in range(0, 180, 3):
            t = math.radians(deg)
            c, s_ = math.cos(t), math.sin(t)
            W = V.copy()
            W[:, 0] = c * V[:, 0] - s_ * V[:, 1]
            W[:, 1] = s_ * V[:, 0] + c * V[:, 1]
            ext = W.max(axis=0) - W.min(axis=0)
            ratio = max(ext[0] / bed[0], ext[1] / bed[1], ext[2] / bed[2])
            key = (0 if ratio <= 1 + 1e-9 else 1, ext[0] * ext[1] if ratio <= 1 + 1e-9 else ratio)
            if best is None or key < best[0]:
                best = (key, R, deg)
        if best[0][0] == 0:
            break
    key, R, deg = best
    t = math.radians(deg)
    Rz = np.array([[math.cos(t), -math.sin(t), 0], [math.sin(t), math.cos(t), 0], [0, 0, 1.0]])
    out = tm.copy()
    out.vertices = (tm.vertices @ R.T) @ Rz.T
    out.vertices -= out.bounds[0]
    return out, key[0] == 0



# ---------------------------------------------------------------- Duebel (Loecher in beiden Teilen + loser Duebel)

def _pole(polys):
    """Punkt im Querschnitt mit dem groessten Abstand zum Rand: (uv, Radius)."""
    big = max(polys, key=lambda p: abs(0.5 * float(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))))
    lo, hi = big.min(axis=0), big.max(axis=0)
    best = (0.0, None)
    n = 37
    xs = np.linspace(lo[0], hi[0], n)
    ys = np.linspace(lo[1], hi[1], n)
    a_all = np.vstack(polys)
    for step in range(2):
        for x in xs:
            for y in ys:
                q = np.array([x, y])
                if not _point_in_polys(q, polys):
                    continue
                dmin = _dist_edges(q, polys)
                if dmin > best[0]:
                    best = (dmin, q)
        if best[1] is None:
            break
        if step == 0:   # feiner um den besten Punkt
            w = max(hi[0] - lo[0], hi[1] - lo[1]) / n * 2
            xs = np.linspace(best[1][0] - w, best[1][0] + w, 17)
            ys = np.linspace(best[1][1] - w, best[1][1] + w, 17)
    return best[1], best[0]


def _dist_edges(q, polys):
    best = float("inf")
    for p in polys:
        a, b = p, np.roll(p, -1, axis=0)
        ab = b - a
        denom = np.maximum((ab * ab).sum(axis=1), 1e-12)
        t = np.clip(((q - a) * ab).sum(axis=1) / denom, 0.0, 1.0)
        best = min(best, float(np.hypot(*(a + ab * t[:, None] - q).T).min()))
    return best


def _cylinder(point, n, h_back, h_front, radius):
    """Zylinder entlang n, von point - n*h_back bis point + n*h_front."""
    cyl = m3.Manifold.cylinder(h_back + h_front, radius, radius, 48)
    R = _rot_to_z(n)
    cyl = cyl.translate((0.0, 0.0, -h_back))
    cyl = cyl.transform(np.hstack([R.T, np.zeros((3, 1))]))
    return cyl.translate(tuple(float(x) for x in point))


def _plan_dowel(first, polys_uv, n, d, frame_back, cfg):
    """Mitte, Radius, Tiefe des Duebels fuer einen Schnitt; None wenn die Flaeche zu klein ist."""
    if not polys_uv:
        return None, "kein Querschnitt"
    q, rmax = _pole(polys_uv)
    if q is None or rmax < 4.0:
        return None, "Schnittflaeche zu klein fuer einen Duebel"
    center = frame_back(q)
    diam = float(cfg.get("diameter_mm") or 0)
    r = diam / 2.0 if diam > 0 else min(rmax * 0.5, 6.0)
    r = min(r, rmax - 1.5)
    if r < 2.0:
        return None, "Schnittflaeche zu klein fuer einen Duebel"
    depth = float(cfg.get("depth_mm", 15))
    lo, hi = _bounds(first)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    proj = corners @ n
    thick = float(max(abs(proj.max() - d), abs(d - proj.min())))
    depth = min(depth, thick - 4.0)
    if depth < 6.0:
        return None, "Teil zu duenn fuer einen Duebel"
    return {"center": [float(x) for x in center], "radius": float(r), "depth": float(depth), "rmax": float(rmax)}, None


def _punch(children, n, d, plan, clearance):
    """Loch in beide Kinder (unter/ueber der Ebene) bohren; liefert (neue Kinder, entferntes Volumen)."""
    c = np.asarray(plan["center"])
    rh = plan["radius"] + clearance / 2.0
    L = plan["depth"]
    out, removed = [], 0.0
    for comp, faces in children:
        lo, hi = _bounds(comp)
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        sd = corners @ n - d
        if sd.max() <= 0.5 and sd.min() < -0.5:       # Teil liegt unter der Ebene
            cyl = _cylinder(c, n, L, 0.5, rh)
        elif sd.min() >= -0.5 and sd.max() > 0.5:     # Teil liegt ueber der Ebene
            cyl = _cylinder(c, n, 0.5, L, rh)
        else:
            out.append((comp, faces))
            continue
        before = comp.volume()
        new = comp - cyl
        after = new.volume()
        if new.is_empty() or after <= 0:
            out.append((comp, faces))
            continue
        removed += before - after
        out.append((new, faces))
    return out, removed


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
    cfg = {"enabled": True, "clearance_mm": 0.3, "depth_mm": 15.0, "diameter_mm": 0.0}
    cfg.update({k: v for k, v in (params.get("connectors") or {}).items() if k in cfg})
    connectors = []
    removed_total = 0.0
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
                "section": _section_3d(M, ("axis", axis, pos)),
            })
            kids = _split_piece(M, faces, axis, pos)
            nvec = np.zeros(3)
            nvec[axis] = 1.0
            kids, rem, conn, why = _connect(M, ("axis", axis, pos), nvec, pos, kids, cfg, {"cut": len(cuts)})
            removed_total += rem
            if conn:
                connectors.append(conn)
            elif why:
                warnings.append(f"Schnitt {len(cuts)}: {why}, kein Duebel")
            for item in kids:
                work.append(item)
    else:
        if not isinstance(manual, list) or len(manual) > 60:
            raise PlanError("Ungueltige Schnittliste")
        done = [(M0, [])]
        for ci, c in enumerate(manual, 1):
            say(f"Schnitt {ci} von {len(manual)}")
            is_free = str(c.get("axis", "")).lower() == "free"
            try:
                pos = float(c["position_mm"])
                if is_free:
                    nrm = _unit(c["normal"])
                    R = _rot_to_z(nrm)
                    axis = None
                else:
                    axis = AXIS_NAMES.index(str(c["axis"]).lower())
            except (KeyError, ValueError, TypeError):
                raise PlanError(f"Schnitt {ci}: Achse oder Position ungueltig")
            label = "frei" if is_free else AXIS_NAMES[axis]
            anchor = None if is_free else c.get("anchor")
            region = c.get("region_mm")
            near = c.get("near")
            near = near if near and len(near) == 3 else None
            if is_free:
                cand = [i for i, (M, f) in enumerate(done) if _crosses(M, nrm, pos)]
            else:
                cand = []
                for idx, (M, faces) in enumerate(done):
                    lo_v, hi_v = _bounds(M)
                    if lo_v[axis] + 0.5 < pos < hi_v[axis] - 0.5:
                        cand.append(idx)
            sel = []
            if near and cand:
                # Klick auf die Figur: nur das Teil schneiden, dessen Querschnitt dem Klickpunkt am naechsten liegt
                if is_free:
                    dists = [(_dist_free(done[i][0], R, pos, near), i) for i in cand]
                else:
                    dists = [(_dist_to_slice(done[i][0], axis, pos, near), i) for i in cand]
                sel = [min(dists)[1]]
            elif anchor and len(anchor) == 2:
                sel = [i for i in cand if _contains_anchor(done[i][0], axis, pos, anchor)]
            if not sel and region and len(region) == 6:
                for i in cand:
                    lo_v, hi_v = _bounds(done[i][0])
                    if all(min(hi_v[k], region[3 + k]) - max(lo_v[k], region[k]) > 1.0 for k in range(3)):
                        sel.append(i)
            if not sel and not anchor and not region and not near:
                sel = cand
            base = {"axis": label, "position_mm": round(pos, 2), "near": near, "region_mm": region, "dowel_mm": c.get("dowel_mm")}
            if is_free:
                base["normal"] = [round(float(x), 5) for x in nrm]
            if not sel:
                warnings.append(f"Schnitt {ci} ({label} = {pos:.1f} mm) trifft kein Teil und wurde ignoriert")
                cuts.append({**base, "area_mm2": 0.0, "contours": 0, "part_extents_mm": [], "anchor": anchor,
                             "pieces_cut": 0, "section": []})
                continue
            if len(done) + len(sel) > MAX_PARTS:
                raise PlanError(f"Mehr als {MAX_PARTS} Teile - Schnittliste pruefen")
            area_sum, contours_sum = 0.0, 0
            for i in sel:
                cs = _slice_free(done[i][0], R, pos) if is_free else _axis_view(done[i][0], axis).slice(float(pos))
                area_sum += float(cs.area())
                contours_sum += int(cs.num_contour())
            first = done[sel[0]][0]
            first_ext = _bounds(first)
            new_anchor = anchor
            if not is_free and not (anchor and len(anchor) == 2 and _contains_anchor(first, axis, pos, anchor)):
                new_anchor = _interior_point(_axis_view(first, axis).slice(float(pos)))
            spec = ("free", R, pos) if is_free else ("axis", axis, pos)
            cuts.append({
                **base,
                "area_mm2": round(area_sum, 1),
                "contours": contours_sum,
                "part_extents_mm": [round(float(x), 1) for x in (first_ext[1] - first_ext[0])],
                "anchor": new_anchor,
                "pieces_cut": len(sel),
                "section": _section_3d(first, spec),
            })
            new_done = []
            for i, (M, faces) in enumerate(done):
                if i in sel:
                    kids = _split_free(M, faces, nrm, pos) if is_free else _split_piece(M, faces, axis, pos)
                    if len(sel) == 1:
                        if is_free:
                            nvec = nrm
                        else:
                            nvec = np.zeros(3)
                            nvec[axis] = 1.0
                        kids, rem, conn, why = _connect(M, spec, nvec, pos, kids, _cut_cfg(cfg, c.get("dowel_mm")), {"cut": len(cuts)})
                        removed_total += rem
                        if conn:
                            connectors.append(conn)
                        elif why:
                            warnings.append(f"Schnitt {len(cuts)}: {why}, kein Duebel")
                    new_done.extend(kids)
                else:
                    new_done.append((M, faces))
            done = new_done

    say("Richte Teile aus")
    parts = []
    for M, faces in done:
        lo_v, hi_v = _bounds(M)
        ext = hi_v - lo_v
        tm = _to_trimesh(M)
        if any(f[0] == "n" for f in faces):
            oriented, fits = _orient_free(tm, M, faces, bed)
            flat, flipped, p = True, False, (0, 1, 2)
            up_orig = "frei"
        else:
            p = _pick_perm(ext, bed, faces, up)
            fits = p is not None
            if p is None:
                p = _fallback_perm(ext, bed)
            oriented, flat, flipped = _orient(tm, p, faces)
            up_orig = AXIS_NAMES[p[2]]
        centroid = (lo_v + hi_v) / 2.0
        parts.append({
            "mesh": oriented,
            "assembled": tm,
            "volume": float(M.volume()),
            "sort": (round(up_sign * float(centroid[up]) / 10.0), float(centroid[0]), float(centroid[2 if up != 2 else 1])),
            "flat_cut_face_down": bool(flat),
            "turned_over": bool(flipped),
            "up_axis_original": up_orig,
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
            zf.writestr(f"vorschau/{name}.stl", trimesh.exchange.stl.export_stl(d["assembled"]))
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
        diff = abs(vol_sum + removed_total - volume_scaled) / max(volume_scaled, 1.0)
        all_fit = all(
            all(sorted(r["extents_mm"])[i] <= sorted(bed)[i] + 0.2 for i in range(3)) for r in part_reports
        )
        for k, cn in enumerate(connectors, 1):
            cyl = trimesh.creation.cylinder(radius=cn["diameter_mm"] / 2.0, height=cn["dowel_length_mm"], sections=48)
            cyl.vertices -= cyl.bounds[0]
            zf.writestr(f"Duebel-{k:02d}.stl", trimesh.exchange.stl.export_stl(cyl))
            cn["name"] = f"Duebel-{k:02d}"
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
            "connectors": connectors,
            "connector_settings": cfg,
            "checks": {
                "all_parts_fit": bool(all_fit),
                "volume_sum_diff_fraction": round(diff, 8),
                "parts_without_flat_face": no_flat,
            },
            "warnings": warnings,
        }
        zf.writestr("plan.json", json.dumps(report, ensure_ascii=False, indent=1))
    return zbuf.getvalue(), report
