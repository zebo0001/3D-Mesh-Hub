# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Zebo0001 (siehe LICENSE und NOTICE; nutzt pymeshfix, GPL-3.0)
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
MAX_DOWELS = int(os.environ.get("MAX_DOWELS", "8"))   # hoechstens so viele Duebel je Schnittflaeche
MAX_PARTS = int(os.environ.get("MAX_PARTS", "200"))
SPLITTER_MM3 = 1000.0   # Teile kleiner als 1 cm3 werden als Splitter gemeldet
# Kleine abgetrennte Inseln (z. B. Spitzen, die die Schnittebene zweimal durchstossen) werden dem Nachbarteil
# beigelegt statt als eigenes Teil ausgegeben.
ISLAND_CM3 = float(os.environ.get("ISLAND_CM3", "20"))
ISLAND_FRACTION = float(os.environ.get("ISLAND_FRACTION", "0.05"))
# Engstellen-Strategie: kleinste erlaubte Teile und Gewichtung (ein Teil mehr ~ so viele cm2 Schnittflaeche)
MIN_PART_CM3 = float(os.environ.get("MIN_PART_CM3", "60"))
MIN_PART_FRACTION = float(os.environ.get("MIN_PART_FRACTION", "0.03"))
PART_COST_CM2 = float(os.environ.get("PART_COST_CM2", "80"))
PROXY_FACES = int(os.environ.get("PROXY_FACES", "40000"))
# Schnitt durch abstehende Teile (Hand, Arm, Zopf) vermeiden: Nebenkonturen zaehlen mehrfach
LIMB_WEIGHT = float(os.environ.get("LIMB_WEIGHT", "8"))
CONTOUR_PENALTY_MM2 = float(os.environ.get("CONTOUR_PENALTY_MM2", "1500"))

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


def _support_score(oriented):
    """Grobe Bewertung einer Druckausrichtung (Bett-Z = oben, Unterkante bei 0); kleiner ist besser.

    Naeherung fuer das Stuetzvolumen: Summe ueber alle Flaechen, die mehr als 45 Grad nach unten zeigen und nicht auf dem Bett
    liegen, von Projektionsflaeche mal Hoehe ueber dem Bett (cm3). Dazu ein Bonus fuer flache Auflageflaeche und ein Malus fuer
    Hoehe ueber 300 mm (wackelt, lange Stuetzen). Gewichte ungetestet gegen weitere Slicer-Laeufe; Rangfolge an einem Teil
    (liegend 44 g Support, hochkant 165 g) bestaetigt."""
    tm = oriented
    N = tm.face_normals
    A = tm.area_faces
    z = tm.triangles_center[:, 2] - float(tm.bounds[0][2])
    down = -N[:, 2]
    over = (down > math.cos(math.radians(45))) & (z > 0.6)
    sup = float((A * down * z)[over].sum()) / 1000.0
    contact = float(A[(down > 0.98) & (z <= 0.6)].sum()) / 100.0
    height = float(tm.bounds[1][2] - tm.bounds[0][2])
    return sup - 2.0 * contact + 4.0 * max(0.0, height - 300.0)


def _hull_xy(oriented):
    from scipy.spatial import ConvexHull
    xy = oriented.vertices[:, :2]
    try:
        return xy[ConvexHull(xy).vertices]
    except Exception:
        return xy


def _hull_over(H, bed):
    """Kleinste Ueberschreitung des Betts (mm) bei Drehung des Grundrisses H; (Ueberschreitung, Winkel). 0 Grad bevorzugt."""
    best = (float("inf"), 0.0)
    for deg in [0.0] + [float(a) for a in range(2, 180, 2)]:
        c, s_ = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        R = H @ np.array([[c, -s_], [s_, c]])
        over = max(np.ptp(R[:, 0]) - bed[0], np.ptp(R[:, 1]) - bed[1], 0.0)
        if over < best[0] - 1e-9:
            best = (over, deg)
        if over <= 1e-6 and deg == 0.0:
            break
    return best


def _spin_fit(oriented, bed):
    """Passt der Grundriss (Projektion auf das Bett) bei Drehung um die Hochachse aufs Bett? Liefert (passt, Winkel, Ueberschreitung)."""
    over, deg = _hull_over(_hull_xy(oriented), bed)
    return over <= 1e-6, deg, over


def _spin(mesh, deg):
    if not deg:
        return mesh
    c, s_ = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    out = mesh.copy()
    v = out.vertices.copy()
    out.vertices = np.column_stack([v[:, 0] * c + v[:, 1] * s_, -v[:, 0] * s_ + v[:, 1] * c, v[:, 2]])   # gleicher Drehsinn wie in _spin_fit
    out.vertices -= out.bounds[0]
    return out


def _pick_perm(ext, bed, faces, up_axis, tm=None, report=None, margin=0.0):
    """Beste Druckausrichtung: Schnittflaeche unten, passend aufs Bett (auch schraeg gedreht), dann wenig Stuetzmaterial.

    Gibt (Zuordnung, Drehwinkel um die Hochachse in Grad) zurueck. Ohne Netz (tm): wie frueher, achsparallel."""
    def flat_down(p):
        if not faces:
            return True
        return any(a == p[2] for a, _ in faces)

    if tm is not None and faces:
        cand = {}
        base_ax = _base_axis(tm, faces)
        for p in PERMS:
            if base_ax is not None and p[2] != base_ax:
                continue
            if ext[p[2]] <= bed[2] + 1e-6 and p[2] not in cand and flat_down(p):
                cand[p[2]] = p
        res = []
        miss = []
        for axis, p in cand.items():
            try:
                o = _orient(tm, p, faces)[0]
                ok, deg, over = _spin_fit(o, bed)
                sc = _support_score(_spin(o, deg))
                if ok:
                    res.append((sc, p, deg))
                else:
                    miss.append((sc, over, AXIS_NAMES[p[2]]))
            except Exception:
                res = []
                break
        if res:
            if report is not None:
                report["scores"] = {AXIS_NAMES[p[2]]: round(sc, 1) for sc, p, _ in res}
            sc, p, deg = min(res, key=lambda r: r[0])
            if report is not None:
                for msc, over, ax in miss:
                    if msc < sc - 200.0 and over <= 2.0 * margin:   # deutlich besser, passt aber nur mit kleinerem Rand
                        report["near_miss"] = (ax, max(0.0, margin - over / 2.0))
            return p, deg
    fits = _fitting_perms(ext, bed)
    if not fits:
        return None, 0.0
    fits.sort(key=lambda p: (0 if flat_down(p) else 1, 0 if p[2] == up_axis else 1, ext[p[2]]))
    return fits[0], 0.0


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

def _sec_stats(cs):
    """(Gesamtflaeche, Zahl aussenliegender Konturen, Flaeche der Nebenkonturen) eines Querschnitts."""
    try:
        polys = cs.to_polygons()
    except Exception:
        return float(cs.area()), int(cs.num_contour()), 0.0
    outer = []
    for p in polys:
        a = np.asarray(p, dtype=float)
        if len(a) < 3:
            continue
        sa = 0.5 * float(np.dot(a[:, 0], np.roll(a[:, 1], -1)) - np.dot(a[:, 1], np.roll(a[:, 0], -1)))
        if sa > 0:
            outer.append(sa)
    area = float(cs.area())
    if not outer:
        return area, int(cs.num_contour()), 0.0
    extra = max(0.0, sum(outer) - max(outer))
    return area, len(outer), extra


def _sec_cost(area, n_outer, extra):
    """Bewertung eines Schnitts (mm2): Flaeche plus Strafe fuer Nebenkonturen (Schnitt durch Hand/Arm/Zopf)."""
    return area + LIMB_WEIGHT * extra + CONTOUR_PENALTY_MM2 * max(n_outer - 1, 0)


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
        area, contours, extra = _sec_stats(cs)
        if area <= 0:
            continue
        dist = (s - ideal) / max(w, 1e-9)
        score = _sec_cost(area, contours, extra) * (1.0 + 0.5 * dist * dist)
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


class _Kids(list):
    """Liste (Teil, Schnittflaechen) plus Zusatzinfos: bundled = Anzahl beigelegter Inseln."""
    bundled = 0


def _bundle_islands(out, sides, vol_parent):
    """Kleine Inseln einer Seite werden dem naechsten groesseren Teil derselben Seite beigelegt.

    Sie werden zusammen mit ihm gedruckt (alle Schnittflaechen liegen in einer Ebene) und danach einzeln angeklebt.
    Gibt (neue Liste, neue Seitenliste, Anzahl beigelegt) zurueck."""
    limit = min(ISLAND_CM3 * 1000.0, ISLAND_FRACTION * float(vol_parent))
    vols = [float(c.volume()) for c, _f in out]
    keep, isl = [], []
    for i in range(len(out)):
        has_host = any(j != i and sides[j] == sides[i] and vols[j] > limit for j in range(len(out)))
        (isl if (vols[i] < limit and has_host) else keep).append(i)
    if not isl:
        return out, sides, 0
    items = {i: [out[i][0], out[i][1], sides[i]] for i in keep}
    cen = {i: np.asarray(out[i][0].to_mesh().vert_properties)[:, :3].mean(axis=0) for i in range(len(out))}
    for i in isl:
        hosts = [j for j in keep if sides[j] == sides[i] and vols[j] > limit]
        j = min(hosts, key=lambda k: float(np.linalg.norm(cen[k] - cen[i])))
        items[j][0] = items[j][0] + out[i][0]
    order = sorted(items)
    return [(items[i][0], items[i][1]) for i in order], [items[i][2] for i in order], len(isl)


def _split_piece(M, faces, axis, pos):
    """Teilt ein Stueck an der Ebene; liefert Liste neuer (Manifold, Schnittflaechen)."""
    normal = [0.0, 0.0, 0.0]
    normal[axis] = 1.0
    above, below = M.split_by_plane(normal, pos)
    out, sides = [], []
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
            sides.append(side)
    out, sides, n_b = _bundle_islands(out, sides, M.volume())
    kids = _Kids(out)
    kids.bundled = n_b
    kids.sides = [("below" if sd == "max" else "above") for sd in sides]
    return kids



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


def _side_of(comp, n, d, tol=0.5):
    """'below' / 'above', je nachdem auf welcher Seite der Ebene alle Eckpunkte liegen (None: beidseitig)."""
    v = np.asarray(comp.to_mesh().vert_properties)[:, :3]
    sd = v @ np.asarray(n, dtype=float) - d
    if sd.max() <= tol and sd.min() < -tol:
        return "below"
    if sd.min() >= -tol and sd.max() > tol:
        return "above"
    return None


def _poly_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _groups(polys):
    """Konturen zu Gruppen (aussen, [Loecher]) ordnen: jede Gruppe ist ein zusammenhaengender Teil des Querschnitts."""
    n = len(polys)
    cont = [[j for j in range(n) if j != i and _point_in_polys(polys[i][0], [polys[j]])] for i in range(n)]
    out = []
    for i in range(n):
        if len(cont[i]) % 2 == 0:
            holes = []
            for k in range(n):
                if len(cont[k]) % 2 == 1:
                    parents = [j for j in cont[k] if len(cont[j]) % 2 == 0]
                    if parents and max(parents, key=lambda j: len(cont[j])) == i:
                        holes.append(polys[k])
            out.append((polys[i], holes))
    return out


def _group_polys(g):
    return [g[0]] + list(g[1])


def _group_area(g):
    return abs(_poly_area(g[0])) - sum(abs(_poly_area(h)) for h in g[1])


def _spots(polys, r, count):
    """Duebelmitten im Querschnitt, symmetrisch angeordnet.

    Ein Duebel: Punkt mit groesstem Randabstand. Mehrere: gleichmaessig verteilt auf der Hauptachse des Querschnitts,
    symmetrisch um dessen Schwerpunkt; so viele wie mit Abstand >= 3,2 r und Wand >= WALL_MM hineinpassen."""
    q0, rmax = _pole(polys)
    if q0 is None:
        return []
    q0 = np.asarray(q0, dtype=float)
    if count <= 1:
        return [q0]
    allp = np.vstack(polys)
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    step = max(r / 2.0, (hi - lo).max() / 60.0)
    pts = [np.array([x, y]) for x in np.arange(lo[0], hi[0] + step, step) for y in np.arange(lo[1], hi[1] + step, step)
           if _point_in_polys(np.array([x, y]), polys)]
    if len(pts) < 3:
        return [q0]
    P = np.array(pts)
    c0 = P.mean(axis=0)
    w, V = np.linalg.eigh(np.cov((P - c0).T))
    u = V[:, int(np.argmax(w))]
    t = (P - c0) @ u
    ext = float(t.max() - t.min())
    tmid = float(t.min() + t.max()) / 2.0
    ok = lambda q: _point_in_polys(q, polys) and _dist_edges(q, polys) >= r + WALL_MM
    line = None
    for k in range(int(count), 1, -1):
        s = ext / k
        while s >= 3.2 * r and line is None:
            cs = [c0 + u * (i - (k - 1) / 2.0) * s for i in range(k)]
            if all(ok(q) for q in cs):
                line = cs
            s *= 0.94
        if line is not None:
            break
    # Unregelmaessiger Querschnitt (z. B. Laengsschnitt durch die ganze Figur): gleichmaessig entlang der Hauptachse
    # verteilen, je Abschnitt an der Stelle mit dem groessten Randabstand. Es gewinnt die Variante mit mehr Duebeln.
    good = [(float(tv), p) for tv, p in zip(t, P) if _dist_edges(p, polys) >= r + WALL_MM]
    slabs = None
    for k in range(int(count), 1, -1):
        picks = []
        for i in range(k):
            t0, t1 = float(t.min()) + ext * i / k, float(t.min()) + ext * (i + 1) / k
            slab = [p for tv, p in good if t0 <= tv <= t1]
            if slab:
                picks.append(max(slab, key=lambda p: _dist_edges(p, polys)))
        if len(picks) >= 2 and all(np.hypot(*(picks[i] - picks[j])) >= 3.2 * r for i in range(len(picks)) for j in range(i)):
            slabs = picks
            break
    best = line if line is not None else []
    if slabs is not None and len(slabs) > len(best):
        best = slabs
    return best if len(best) >= 2 else [q0]


WALL_MM = 3.0           # Mindestwand um ein Loch (seitlich zum Teilrand)
BACK_WALL_MM = 2.0      # Mindestwand hinter dem Lochgrund
MIN_DEPTH_MM = 6.0
MIN_RADIUS_MM = 2.5


def _plan_dowels(first, groups, n, d, frame_back, cfg):
    """Duebel fuer einen Schnitt: je zusammenhaengender Schnittflaeche mindestens einer, bei grossen Flaechen mehrere.

    Groesse automatisch nach dem Querschnitt (Radius ca. 30 % des Randabstands, 2,5 bis 10 mm), Zieltiefe 2 r + 3 mm
    (mindestens die eingestellte Tiefe). Ob das in beiden Teilen Platz hat, prueft _fit_dowel."""
    if not groups:
        return [], "kein Querschnitt"
    poles = [(_pole(_group_polys(g)), g) for g in groups]
    poles = [(q, rm, g) for (q, rm), g in poles if q is not None]
    if not poles:
        return [], "Schnittflaeche zu klein fuer einen Duebel"
    diam = float(cfg.get("diameter_mm") or 0)
    depth_cfg = float(cfg.get("depth_mm", 15))
    plans = []
    for q, rm, g in poles:
        r = diam / 2.0 if diam > 0 else min(max(0.3 * rm, MIN_RADIUS_MM), 10.0)
        r = min(r, rm - WALL_MM)
        if r < MIN_RADIUS_MM:
            continue
        count = int(max(1, min(MAX_DOWELS, math.floor(_group_area(g) / (math.pi * (4.0 * r) ** 2)))))
        _sp = _spots(_group_polys(g), r, count)
        for c in _sp:
            plans.append({"center": [float(x) for x in frame_back(c)], "radius": float(r), "depth": float(max(depth_cfg, 2 * r + 3)), "rmax": float(rm)})
    if not plans:
        return [], "Schnittflaeche zu klein fuer einen Duebel"
    return plans, None


def _fit_dowel(plan, children, n, d, clearance, sides=None):
    """Erst mit normaler Wand/Mindesttiefe; scheitert das (duenne, gekruemmte Teile wie ein Zopf), mit knapperen Werten."""
    out = _fit_dowel_try(plan, children, n, d, clearance, sides, WALL_MM, MIN_DEPTH_MM)
    if out is None:
        out = _fit_dowel_try(plan, children, n, d, clearance, sides, 1.6, 4.0)
    return out


def _fit_dowel_try(plan, children, n, d, clearance, sides, wall, min_depth):
    """Passt den Duebel an den tatsaechlichen Platz an: je Teil die Lochtiefe, gemeinsam den Radius.

    Pruefkoerper: Zylinder (Loch + Wand) muss ganz im Material liegen. Zuerst Tiefe verkuerzen (bis 6 mm), dann den Radius
    um 15 % verkleinern (bis 2,5 mm). Gibt None zurueck, wenn nirgends Platz ist."""
    c = np.asarray(plan["center"], dtype=float)
    by_side = {"below": [], "above": []}
    for ci, (comp, _f) in enumerate(children):
        side = sides[ci] if sides else _side_of(comp, n, d)
        if side in by_side:
            by_side[side].append(comp)
    if not by_side["below"] or not by_side["above"]:
        return None
    r = plan["radius"]
    while r >= MIN_RADIUS_MM - 1e-9:
        rt = r + clearance / 2.0 + wall / 2.0
        depths = {}
        for side, comps in by_side.items():
            found = None
            for dep in np.arange(plan["depth"], min_depth - 0.01, -2.0):
                L = dep + BACK_WALL_MM - 0.3
                if side == "below":
                    test = _cylinder(c - n * 0.3, n, L, 0.0, rt)
                else:
                    test = _cylinder(c + n * 0.3, n, 0.0, L, rt)
                vt = float(test.volume())
                if any(float((comp ^ test).volume()) >= 0.985 * vt for comp in comps):
                    found = float(dep)
                    break
            if found is None:
                break
            depths[side] = found
        if len(depths) == 2:
            out = dict(plan)
            out["radius"] = float(r)
            out["depth_below"], out["depth_above"] = depths["below"], depths["above"]
            out["depth"] = max(depths.values())
            return out
        r *= 0.85
    return None


def _connect(first, spec, n, d, children, cfg, report_extra, groups=None, sides=None):
    """Duebel planen und Loecher bohren. Liefert (Kinder, entferntes Volumen, Liste von Verbindern, Warnung|None).

    groups: nur diese Schnittflaechen verbinden (sonst alle des Querschnitts); sides: Seite je Kind ('below'/'above')."""
    if not cfg.get("enabled"):
        return children, 0.0, [], None
    if sides is None:
        sides = getattr(children, "sides", None)
    polys, to3 = _section_polys(first, spec)
    if groups is None:
        groups = _groups(polys)
    plans, why = _plan_dowels(first, groups, n, d, lambda q: to3(q[0], q[1]), cfg)
    if not plans:
        return children, 0.0, [], why
    clearance = float(cfg.get("clearance_mm", 0.3))
    planned = len(plans)
    plans = [p for p in (_fit_dowel(p, children, n, d, clearance, sides) for p in plans) if p]
    if not plans:
        return children, 0.0, [], "an den Dübelstellen ist zu wenig Material (Teil zu dünn)"
    if len(plans) < planned:
        why = f"{planned - len(plans)} von {planned} Dübeln wegen zu dünner Teile weggelassen"
    conns = []
    removed_total = 0.0
    kids = children
    for plan in plans:
        kids, removed = _punch(kids, n, d, plan, clearance, sides)
        removed_total += removed
        conn = {
            "center_mm": [round(x, 2) for x in plan["center"]],
            "normal": [round(float(x), 5) for x in n],
            "diameter_mm": round(plan["radius"] * 2, 2),
            "hole_diameter_mm": round(plan["radius"] * 2 + clearance, 2),
            "depth_mm": round(plan["depth"], 1),
            "depth_below_mm": round(plan["depth_below"], 1),
            "depth_above_mm": round(plan["depth_above"], 1),
            "dowel_length_mm": round(plan["depth_below"] + plan["depth_above"] - 1.5, 1),
            "clearance_mm": clearance,
        }
        conn.update(report_extra)
        conns.append(conn)
    return kids, removed_total, conns, None


def _local_split(M, spec, n, d, near, faces):
    """Schnitt nur durch die Schnittflaeche, die dem Klickpunkt am naechsten liegt (z. B. nur der Arm).

    Gibt (Kinder, Seiten, Gruppen) zurueck oder None, wenn der Querschnitt nur aus einer Flaeche besteht."""
    polys, _ = _section_polys(M, spec)
    groups = _groups(polys)
    if len(groups) < 2:
        return None
    if spec[0] == "axis":
        q = np.array(_view_uv(spec[1], near), dtype=float)
    else:
        q = (spec[1] @ np.asarray(near, dtype=float))[:2]
    g = min(groups, key=lambda gr: _dist_to_polys(q, _group_polys(gr)))
    cp, _ = _pole(_group_polys(g))
    if cp is None:
        return None
    full = _split_free(M, faces, n, d) if spec[0] == "free" else _split_piece(M, faces, spec[1], d)
    hit = {}
    for comp, fc in full:
        side = _side_of(comp, n, d)
        if side is None:
            continue
        pos = d - 0.3 if side == "below" else d + 0.3
        cs = _slice_free(comp, spec[1], pos) if spec[0] == "free" else _axis_view(comp, spec[1]).slice(float(pos))
        if _point_in_polys(cp, _polys_of(cs)):
            hit[side] = (comp, fc)
    if len(hit) < 2:
        return None
    small_side = min(hit, key=lambda k: float(hit[k][0].volume()))
    small = hit[small_side]
    big_side = "above" if small_side == "below" else "below"
    rest_faces = hit[big_side][1]
    rest = hit[big_side][0]
    for comp, fc in full:
        if comp is small[0] or comp is hit[big_side][0]:
            continue
        rest = rest + comp
    return [small, (rest, rest_faces)], [small_side, big_side], [g]


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


def _punch(children, n, d, plan, clearance, sides=None):
    """Loch in beide Kinder (unter/ueber der Ebene) bohren; liefert (neue Kinder, entferntes Volumen)."""
    c = np.asarray(plan["center"])
    rh = plan["radius"] + clearance / 2.0
    out, removed = [], 0.0
    for ci, (comp, faces) in enumerate(children):
        side = sides[ci] if sides else _side_of(comp, n, d)
        if side == "below":       # Teil liegt unter der Ebene
            cyl = _cylinder(c, n, plan["depth_below"], 0.5, rh)
        elif side == "above":     # Teil liegt ueber der Ebene
            cyl = _cylinder(c, n, 0.5, plan["depth_above"], rh)
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


# ---------------------------------------------------------------- Engstellen-Strategie (Gliedmassen, Fluegel abtrennen)

def _parts_needed(ext, bed):
    """Untere Schranke fuer die Zahl der Teile eines Stuecks: Raster aus Bettgroessen (beste Achsenzuordnung)."""
    best = None
    for p in PERMS:
        n = 1
        for i in range(3):
            n *= max(1, math.ceil(float(ext[p[i]]) / bed[i] - 1e-9))
        best = n if best is None else min(best, n)
    return best


def _proxy(M):
    """Grob vereinfachte Kopie fuer die Kandidatensuche (Schnitte werden danach am Original ausgefuehrt)."""
    tm = _to_trimesh(M)
    if len(tm.faces) <= PROXY_FACES * 1.5:
        return M
    try:
        simp = tm.simplify_quadric_decimation(face_count=PROXY_FACES)
        return _to_manifold(simp)
    except Exception:
        return M


def _neck_candidates(M, ext_min=MIN_PIECE_MM):
    """Kandidaten (Achse, Position, Querschnitt cm2, Konturen) an Engstellen: kleiner Querschnitt im Verhaeltnis zum
    kleineren abgetrennten Volumen. Volumen aus dem Querschnittsprofil (Trapezregel)."""
    lo_v, hi_v = _bounds(M)
    vol = float(M.volume()) / 1000.0   # cm3
    out = []
    for axis in range(3):
        lo, hi = float(lo_v[axis]), float(hi_v[axis])
        if hi - lo < 2 * ext_min + 1:
            continue
        V = _axis_view(M, axis)
        zs = np.linspace(lo + 0.5, hi - 0.5, 82)
        A, C, K = [], [], []
        for z in zs:
            cs = V.slice(float(z))
            a_, c_, e_ = _sec_stats(cs)
            A.append(a_ / 100.0)
            C.append(c_)
            K.append(_sec_cost(a_, c_, e_) / 100.0)
        A = np.asarray(A)
        cum = np.concatenate([[0.0], np.cumsum((A[1:] + A[:-1]) / 2.0 * np.diff(zs) / 10.0)])
        tot = float(cum[-1]) or 1.0
        cum *= vol / tot
        min_v = max(MIN_PART_CM3, MIN_PART_FRACTION * vol)
        rows = []
        for i, z in enumerate(zs):
            if z - lo < ext_min or hi - z < ext_min or A[i] <= 0:
                continue
            vs = min(cum[i], vol - cum[i])
            if vs < min_v:
                continue
            rows.append((K[i] / vs ** (2.0 / 3.0), K[i], float(z), C[i]))
        picked = []
        for key in (lambda r: r[0], lambda r: r[1]):
            n_ok = 0
            for r in sorted(rows, key=key):
                if any(abs(r[2] - q[2]) < 15.0 for q in picked):
                    continue
                picked.append(r)
                n_ok += 1
                if n_ok >= 5:
                    break
        for r in picked:
            out.append((axis, r[2], r[1], r[3]))
    return out


def _smart_cut(M, faces, bed, say=None):
    """Bester Schnitt ueber alle Achsen: wenige Teile, kleine Schnittflaeche, keine Mini-Teile.

    Gibt (axis, pos) zurueck oder None, wenn kein Kandidat die geschaetzte Teilezahl senkt (dann klassisch)."""
    lo_v, hi_v = _bounds(M)
    n_parent = _parts_needed(hi_v - lo_v, bed)
    P = _proxy(M)
    vol_p = float(P.volume())
    best = None
    for axis, pos, area, contours in _neck_candidates(P):
        kids = _split_piece(P, faces, axis, pos)
        if len(kids) < 2:
            continue
        vols = [float(c.volume()) for c, _f in kids]
        if min(vols) < max(MIN_PART_CM3 * 1000.0, MIN_PART_FRACTION * vol_p):
            continue
        n_sum = 0
        for c, _f in kids:
            l, h = _bounds(c)
            n_sum += _parts_needed(h - l, bed)
        if n_sum >= n_parent:
            continue
        cost = n_sum * PART_COST_CM2 + area + 10.0 * kids.bundled
        if best is None or cost < best[0]:
            best = (cost, axis, pos)
    if best is None:
        return None
    return best[1], best[2]


def _base_axis(tm, faces):
    """Achse der groessten Schnittflaeche des Teils (darauf soll es stehen); None ohne Schnittflaechen."""
    cand = [f for f in faces if f[0] in (0, 1, 2)]
    if not cand:
        return None
    N = tm.face_normals
    A = tm.area_faces
    C = tm.triangles_center
    lo, hi = tm.bounds
    best = None
    for a, side in cand:
        edge = lo[a] if side == "min" else hi[a]
        sgn = -1.0 if side == "min" else 1.0
        m = (N[:, a] * sgn > 0.98) & (np.abs(C[:, a] - edge) < 0.5)
        area = float(A[m].sum())
        if best is None or area > best[0]:
            best = (area, a)
    return best[1]


def _stand_over(M, faces, bed, tm=None):
    """Wie weit (mm) das Teil aufrecht auf einer Schnittflaeche stehend das Bett ueberragt; 0 = steht und passt.

    Ungeschnittene Teile und freie Schnitte zaehlen als in Ordnung (nichts abzulegen / eigene Ausrichtung)."""
    if not faces or any(f[0] == "n" for f in faces):
        return 0.0
    lo_v, hi_v = _bounds(M)
    ext = hi_v - lo_v
    tm = tm if tm is not None else _to_trimesh(M)
    base = _base_axis(tm, faces)
    axes = [base] if base is not None else []
    if not axes:
        return 0.0
    best = None
    for a in axes:
        if ext[a] > bed[2] + 1e-6:
            over = 1000.0 + float(ext[a] - bed[2])
        else:
            o = [i for i in range(3) if i != a]
            H = _hull_xy_pts(np.asarray(tm.vertices)[:, o])
            over = _hull_over(H, bed)[0]
        if best is None or over < best:
            best = over
    return float(best)


def _hull_xy_pts(xy):
    from scipy.spatial import ConvexHull
    try:
        return xy[ConvexHull(xy).vertices]
    except Exception:
        return xy


def _stand_cut(M, faces, bed):
    """Schnitt fuer ein Teil, das nur gekippt ins Bett passt: trennt ueberstehende Teile (Arme, Fluegel) ab, damit der
    Rest auf der Schnittflaeche stehen kann. Gibt (axis, pos) oder None zurueck."""
    P = _proxy(M)
    vol_p = float(P.volume())
    parent = _stand_over(P, faces, bed)
    best = None
    for axis, pos, area, contours in _neck_candidates(P):
        kids = _split_piece(P, faces, axis, pos)
        if len(kids) < 2:
            continue
        vols = [float(c.volume()) for c, _f in kids]
        if min(vols) < max(MIN_PART_CM3 * 1000.0, MIN_PART_FRACTION * vol_p):
            continue
        bad = 0.0
        n_sum = 0
        for c, f in kids:
            bad += _stand_over(c, f, bed)
            l, h = _bounds(c)
            n_sum += _parts_needed(h - l, bed)
        if bad >= parent - 1e-6:
            continue
        cost = bad * 3.0 + n_sum * PART_COST_CM2 + area + 10.0 * kids.bundled
        if best is None or cost < best[0]:
            best = (cost, axis, pos)
    if best is None:
        return None
    return best[1], best[2]


def _plan_score(report):
    """Kleiner ist besser: Teilezahl, Schnittflaechen, Mini-Teile."""
    area = sum(float(c.get("cost_mm2", c.get("area_mm2", 0))) for c in report.get("cuts", [])) / 100.0
    small = sum(1 for p in report.get("parts", []) if p["volume_cm3"] < MIN_PART_CM3)
    return report["part_count"] * PART_COST_CM2 + area + 40.0 * small + (1e6 if not report["checks"]["all_parts_fit"] else 0.0)


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

    search_note = None
    if params.get("max_scale_search") and not params.get("_inner") and params.get("cuts") is None:
        base = dict(params, max_scale_search=False, _inner=True, connectors=dict(params.get("connectors") or {}, enabled=False))
        base.pop("target_height_mm", None)

        def run(sc):
            try:
                return split_mesh(path, dict(base, scale=sc))[1]
            except PlanError:
                return None

        def good(r, n):
            return r is not None and r["checks"]["all_parts_fit"] and r["part_count"] <= n

        say("Suche groessten Massstab (Probelauf 1)")
        r0 = run(scale)
        if r0 is None or not r0["checks"]["all_parts_fit"]:
            search_note = "Maximalen Massstab suchen: schon der gewaehlte Massstab passt nicht, es wurde nicht gesucht"
        else:
            n0, ok, bad, probe = r0["part_count"], scale, None, 1
            cur = scale
            while bad is None and cur < scale * 1.6:
                cur *= 1.03
                probe += 1
                say(f"Suche groessten Massstab (Probelauf {probe}, x{cur:.2f})")
                if good(run(cur), n0):
                    ok = cur
                else:
                    bad = cur
            for _ in range(4 if bad else 0):
                mid = (ok + bad) / 2.0
                probe += 1
                say(f"Suche groessten Massstab (Probelauf {probe}, x{mid:.2f})")
                if good(run(mid), n0):
                    ok = mid
                else:
                    bad = mid
            final = math.floor(ok * 20 + 1e-9) / 20.0
            if final != ok:
                probe += 1
                say(f"Suche groessten Massstab (Probelauf {probe}, x{final:.2f})")
                if not good(run(final), n0):
                    final = ok
            scale = final
            search_note = f"Groesster Massstab mit {n0} Teilen (gerundet auf 0,05): x{final:.2f}, Hoehe {final * float(ext0[up]):.0f} mm"

    strategy = str(params.get("strategy", "auto")).lower()
    if strategy not in ("auto", "legacy", "smart"):
        strategy = "auto"
    if strategy == "auto" and params.get("cuts") is None and not params.get("_inner"):
        # beide Plaene rechnen und den besseren nehmen (bei Gleichstand der klassische)
        base = dict(params, _inner=True, max_scale_search=False, scale=scale)
        base.pop("target_height_mm", None)
        say("Plan 1: klassisch")
        d0, r0 = split_mesh(path, dict(base, strategy="legacy"), (lambda m: say("Plan 1: " + m)) if progress else None)
        say("Plan 2: Engstellen (Gliedmassen/Fluegel)")
        try:
            d1, r1 = split_mesh(path, dict(base, strategy="smart"), (lambda m: say("Plan 2: " + m)) if progress else None)
        except PlanError:
            d1, r1 = None, None
        s0 = _plan_score(r0)
        s1 = _plan_score(r1) if r1 else None
        use_smart = r1 is not None and s1 < s0 - 1e-6
        data, rep = (d1, r1) if use_smart else (d0, r0)
        rep["strategy"] = "smart" if use_smart else "legacy"
        rep["strategy_compare"] = {
            "legacy": {"parts": r0["part_count"], "score": round(s0, 1)},
            "smart": {"parts": r1["part_count"], "score": round(s1, 1)} if r1 else None,
        }
        if use_smart:
            rep["warnings"].insert(0, f"Plan nach Engstellen gewaehlt: {r1['part_count']} statt {r0['part_count']} Teile (Fluegel/Gliedmassen an schmalen Stellen abgetrennt)")
        if search_note:
            rep["warnings"].insert(0, search_note)
        return data, rep

    bed_in = params.get("bed") or {}
    margin = float(params.get("margin_mm", 5))
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
    if search_note:
        warnings.append(search_note)
    cfg = {"enabled": True, "clearance_mm": 0.3, "depth_mm": 15.0, "diameter_mm": 0.0}
    cfg.update({k: v for k, v in (params.get("connectors") or {}).items() if k in cfg})
    connectors = []
    removed_total = 0.0
    manual = params.get("cuts")
    cuts = []
    stable_on = bool(params.get("stable", True))
    unstable_cuts = []
    if manual is None:
        work = [(M0, [])]
        done = []
        while work:
            M, faces = work.pop()
            lo_v, hi_v = _bounds(M)
            ext = hi_v - lo_v
            fits_box = bool(_fitting_perms(ext, bed))
            unstable = False
            if fits_box and stable_on and faces:
                unstable = _stand_over(M, faces, bed) > 1e-6
            if fits_box and not unstable:
                done.append((M, faces))
                continue
            if len(done) + len(work) >= MAX_PARTS:
                raise PlanError(f"Mehr als {MAX_PARTS} Teile - Einstellungen pruefen (Zielhoehe, Druckbett)")
            axis, ratio, limit = _worst_axis(ext, bed)
            n = max(2, math.ceil(ratio - 1e-9))
            lo, hi = float(lo_v[axis]), float(hi_v[axis])
            say(f"Schnitt {len(cuts) + 1} ({len(done) + len(work) + 1} Teile)")
            smart = None
            if unstable:
                smart = _stand_cut(M, faces, bed)
                if smart is None:
                    done.append((M, faces))   # kein sinnvoller Schnitt: gekippt drucken, Warnung folgt
                    continue
                unstable_cuts.append(len(cuts) + 1)
            elif strategy == "smart":
                smart = _smart_cut(M, faces, bed)
            if smart:
                axis, pos = smart
            else:
                pos, area, contours = _choose_cut(M, axis, lo, hi, n, limit)
            cs0 = _axis_view(M, axis).slice(float(pos))
            area, contours, extra_mm2 = _sec_stats(cs0)
            anchor = _interior_point(_axis_view(M, axis).slice(float(pos)))
            cuts.append({
                "axis": AXIS_NAMES[axis],
                "position_mm": round(pos, 2),
                "area_mm2": round(area, 1),
                "contours": contours,
                "cost_mm2": round(_sec_cost(area, contours, extra_mm2), 1),
                "part_extents_mm": [round(float(x), 1) for x in ext],
                "anchor": anchor,
                "region_mm": [round(float(x), 2) for x in list(lo_v) + list(hi_v)],
                "pieces_cut": 1,
                "section": _section_3d(M, ("axis", axis, pos)),
            })
            kids = _split_piece(M, faces, axis, pos)
            nvec = np.zeros(3)
            nvec[axis] = 1.0
            nb = getattr(kids, "bundled", 0)
            if nb:
                warnings.append(f"Schnitt {len(cuts)}: {nb} kleine Insel(n) dem Nachbarteil beigelegt (zusammen gedruckt, danach ankleben)")
            kids, rem, conns, why = _connect(M, ("axis", axis, pos), nvec, pos, kids, cfg, {"cut": len(cuts)})
            removed_total += rem
            if conns:
                connectors.extend(conns)
            if why:
                warnings.append(f"Schnitt {len(cuts)}: {why}" + ("" if conns else ", kein Duebel"))
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
            spec = ("free", R, pos) if is_free else ("axis", axis, pos)
            nvec_l = nrm if is_free else np.eye(3)[axis]
            local = _local_split(done[sel[0]][0], spec, nvec_l, pos, near, done[sel[0]][1]) if (near and len(sel) == 1) else None
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
            section = _section_3d(first, spec)
            if local:
                gp = [p for g in local[2] for p in _group_polys(g)]
                _, to3 = _section_polys(first, spec)
                section = [[[round(float(c), 2) for c in to3(u, v)] for u, v in _decimate(p)] for p in gp]
                area_sum = sum(_group_area(g) for g in local[2])
                contours_sum = len(gp)
            cuts.append({
                **base,
                "area_mm2": round(area_sum, 1),
                "contours": contours_sum,
                "part_extents_mm": [round(float(x), 1) for x in (first_ext[1] - first_ext[0])],
                "anchor": new_anchor,
                "pieces_cut": len(sel),
                "section": section,
                "local": bool(local),
            })
            new_done = []
            for i, (M, faces) in enumerate(done):
                if i in sel:
                    sides = None
                    groups = None
                    if local:
                        kids, sides, groups = local
                    else:
                        kids = _split_free(M, faces, nrm, pos) if is_free else _split_piece(M, faces, axis, pos)
                    if len(sel) == 1:
                        if is_free:
                            nvec = nrm
                        else:
                            nvec = np.zeros(3)
                            nvec[axis] = 1.0
                        kids, rem, conns, why = _connect(M, spec, nvec, pos, kids, _cut_cfg(cfg, c.get("dowel_mm")), {"cut": len(cuts)}, groups, sides)
                        removed_total += rem
                        if conns:
                            connectors.extend(conns)
                        if why:
                            warnings.append(f"Schnitt {len(cuts)}: {why}" + ("" if conns else ", kein Duebel"))
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
            _rep = {}
            p, spin = _pick_perm(ext, bed, faces, up, tm if str(params.get("orient", "support")) == "support" else None, _rep, margin)
            if _rep.get("near_miss"):
                _ax, _m = _rep["near_miss"]
                warnings.append(f"Ein Teil ({'x'.join(str(round(float(e))) for e in ext)} mm) liesse sich liegend mit deutlich weniger Support drucken, passt dann aber nur mit Rand <= {_m:.0f} mm (jetzt {margin:.0f} mm)")
            fits = p is not None
            if p is None:
                p = _fallback_perm(ext, bed)
            oriented, flat, flipped = _orient(tm, p, faces)
            oriented = _spin(oriented, spin)
            up_orig = AXIS_NAMES[p[2]]
        centroid = (lo_v + hi_v) / 2.0
        parts.append({
            "mesh": oriented,
            "assembled": tm,
            "volume": float(M.volume()),
            "sort": (round(up_sign * float(centroid[up]) / 10.0), float(centroid[0]), float(centroid[2 if up != 2 else 1])),
            "flat_cut_face_down": bool(flat),
            "has_cut": bool(faces),
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
                "has_cut": d["has_cut"],
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
        dowel_files = {}
        for cn in connectors:
            key = (cn["diameter_mm"], cn["dowel_length_mm"])
            if key not in dowel_files:
                k = len(dowel_files) + 1
                cyl = trimesh.creation.cylinder(radius=cn["diameter_mm"] / 2.0, height=cn["dowel_length_mm"], sections=48)
                cyl.vertices -= cyl.bounds[0]
                zf.writestr(f"Duebel-{k:02d}.stl", trimesh.exchange.stl.export_stl(cyl))
                dowel_files[key] = f"Duebel-{k:02d}"
            cn["name"] = dowel_files[key]
        if diff > 1e-4:
            warnings.append(f"Volumensumme weicht um {diff * 100:.3f} % vom Original ab - Ergebnis pruefen")
        tiny = sum(1 for r in part_reports if r["tiny"])
        if tiny:
            warnings.append(f"{tiny} sehr kleine Teile (unter 1 cm3) entstanden - Schnitte pruefen")
        nofit = sum(1 for r in part_reports if not r["fits"])
        if nofit:
            warnings.append(f"{nofit} Teile passen noch nicht aufs Druckbett - weitere Schnitte setzen")
        no_flat = sum(1 for r in part_reports if not r["flat_cut_face_down"])
        if unstable_cuts:
            warnings.append("Schnitt " + ", ".join(str(i) for i in unstable_cuts) + ": trennt ueberstehende Teile (Arme/Fluegel) ab, damit die Teile auf der Schnittflaeche stehen koennen (mit 'Groessten Massstab suchen' findest du den groessten Massstab, der ohne diese Zusatzschnitte auskommt)")
        tilted = sum(1 for r in part_reports if r["fits"] and not r["flat_cut_face_down"] and r["has_cut"])
        if tilted:
            warnings.append(f"{tilted} Teile muessen gekippt oder liegend gedruckt werden (stehen nicht auf einer Schnittflaeche im Bett) - mit viel Support, ggf. weitere Schnitte oder kleineren Massstab waehlen")
        report = {
            "scale": round(scale, 5),
            "model_height_mm": round(float(ext0[up]), 2),
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


# ---------------------------------------------------------------- Positionspruefung fuer einen Schnitt

def probe_cut(path, params, progress=None):
    """Prueft Positionen rund um einen achsparallelen Schnitt (params["probe"] = {axis, position_mm, index, span, step}).

    Betrachtet das Stueck zwischen den Nachbarschnitten auf derselben Achse (grobes Netz, schnell). Je Position:
    Konturen der Schnittflaeche, beigelegte Inseln, ob alle Teile aufrecht auf ihrer groessten Schnittflaeche ins Bett passen.
    Gibt (leeres ZIP, Bericht mit "probe") zurueck."""
    def say(msg):
        if progress:
            progress(msg)

    pr = params.get("probe") or {}
    axis_name = str(pr.get("axis", "")).lower()
    if axis_name not in AXIS_NAMES:
        raise PlanError("Positionspruefung: nur achsparallele Schnitte (x, y, z)")
    axis = AXIS_NAMES.index(axis_name)
    p0 = float(pr["position_mm"])
    span = min(max(float(pr.get("span", 60)), 10.0), 300.0)
    step = min(max(float(pr.get("step", 2)), 1.0), 50.0)
    say("Lade Datei")
    loaded = trimesh.load(path, force="mesh", process=True)
    if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
        raise PlanError("Die Datei enthaelt kein lesbares Dreiecksnetz")
    if not loaded.is_watertight:
        raise PlanError("Das Netz ist nicht geschlossen. Bitte zuerst 'Mesh pruefen und reparieren' ausfuehren.")
    ext0 = loaded.extents
    up_mode = str(params.get("up_axis", "auto")).lower()
    up = int(np.argmax(ext0)) if up_mode == "auto" else AXIS_NAMES.index(up_mode)
    if params.get("target_height_mm"):
        scale = float(params["target_height_mm"]) / float(ext0[up])
    else:
        scale = float(params.get("scale", 1.0))
    bed_in = params.get("bed") or {}
    margin = float(params.get("margin_mm", 5))
    bed = [float(bed_in.get(k, 0)) - 2 * margin for k in ("x", "y", "z")]
    loaded.apply_scale(scale)
    loaded.vertices -= loaded.bounds[0]
    say("Vereinfache")
    P = _proxy(_to_manifold(loaded))
    del loaded
    # Stueck zwischen den Nachbarschnitten
    others = [float(c["position_mm"]) for i, c in enumerate(params.get("cuts") or [])
              if str(c.get("axis", "")).lower() == axis_name and i != pr.get("index")]
    lo_all, hi_all = _bounds(P)
    lo_n = max([q for q in others if q < p0 - 1.0] + [float(lo_all[axis])])
    hi_n = min([q for q in others if q > p0 + 1.0] + [float(hi_all[axis])])
    piece, faces = P, []
    if lo_n > lo_all[axis] + 0.5:
        k = [c for c in _split_piece(piece, faces, axis, lo_n) if _bounds(c[0])[0][axis] >= lo_n - 0.5]
        if k:
            piece, faces = max(k, key=lambda c: float(c[0].volume()))
    if hi_n < hi_all[axis] - 0.5:
        k = [c for c in _split_piece(piece, faces, axis, hi_n) if _bounds(c[0])[1][axis] <= hi_n + 0.5]
        if k:
            piece, faces = max(k, key=lambda c: float(c[0].volume()))
    lo_v, hi_v = _bounds(piece)
    a, b = max(p0 - span, float(lo_v[axis]) + MIN_PIECE_MM), min(p0 + span, float(hi_v[axis]) - MIN_PIECE_MM)
    if a >= b:
        raise PlanError("Positionspruefung: zu wenig Platz zwischen den Nachbarschnitten")
    cands = sorted({round(float(x), 1) for x in np.arange(math.ceil(a / step) * step, b + 1e-9, step)} | {round(p0, 1)})
    cands = [c for c in cands if a - 1e-6 <= c <= b + 1e-6]
    V = _axis_view(piece, axis)
    rows = []
    for ci, pos in enumerate(cands):
        say(f"Pruefe Position {ci + 1} von {len(cands)}")
        cs = V.slice(float(pos))
        area, contours, extra = _sec_stats(cs)
        if area <= 0:
            continue
        kids = _split_piece(piece, faces, axis, pos)
        if len(kids) < 2:
            continue
        over = 0.0
        fits = True
        for c, f in kids:
            over += _stand_over(c, f, bed)
            l, h = _bounds(c)
            fits = fits and bool(_fitting_perms(h - l, bed))
        rows.append({
            "position_mm": pos,
            "area_cm2": round(area / 100.0, 1),
            "contours": int(contours),
            "bundled": int(getattr(kids, "bundled", 0)),
            "stands": bool(over <= 0.1),   # Netz ist vereinfacht: 0,1 mm Toleranz
            "over_mm": round(float(over), 1),
            "fits": bool(fits),
            "current": abs(pos - p0) < 0.05,
        })
    good = [r for r in rows if r["stands"] and r["fits"]]
    best = min(good, key=lambda r: (r["contours"], r["bundled"], r["area_cm2"] * (1 + 0.002 * abs(r["position_mm"] - p0)))) if good else None
    if best:
        best["recommended"] = True
    report = {"probe": {"axis": axis_name, "index": pr.get("index"), "from_mm": a, "to_mm": b,
                        "position_mm": p0, "rows": rows, "bed_usable_mm": [round(x, 1) for x in bed]}}
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w") as zf:
        zf.writestr("probe.json", json.dumps(report))
    return zbuf.getvalue(), report
