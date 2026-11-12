import * as fs from "node:fs";
import * as path from "node:path";
import type { Brush, Entity, MapFile, Vec3 } from "./map/model.js";
import { classname, getProp, parseOrigin } from "./map/model.js";
import { parseMap } from "./map/parser.js";
import { brushBounds, planeFromPoints, type Bounds } from "./map/geometry.js";
import { intersects, solidFromBrush, transformBrush } from "./map/csg.js";

/**
 * Kitbash prefabs: small .map files in a library folder, placed into a level as TrenchBroom groups.
 *
 * Prefab convention (the file's own coordinates):
 *  - worldspawn brushes are the piece; origin (0,0,0) is its anchor: on the floor, and for wall pieces on the wall plane.
 *  - the piece faces +x. A wall piece's back is the plane x = 0 and the piece lies in x >= 0.
 *  - `prefab_socket` point entities mark where other pieces join: "name", "origin", and "angle" (degrees, the direction
 *    a joining piece leaves in, i.e. the socket's outward facing). Two sockets join when their origins meet and their
 *    angles are opposite.
 *  - optional worldspawn keys: "prefab_mount" floor | wall | free, "prefab_note" (what it is, how to use it).
 * A placed instance is a func_group named "<prefab>#<n>" whose `_prefab` key holds the name and `_prefab_sockets` the
 * sockets in map coordinates ("name x y z angle; ..."), so a later placement can snap to it.
 */

export interface Socket { name: string; origin: Vec3; angle: number }
export interface Prefab { name: string; file: string; brushes: Brush[]; sockets: Socket[]; mount: string; note: string; bounds: Bounds | null }

export function loadPrefab(file: string): Prefab {
  const map = parseMap(fs.readFileSync(file, "utf8"));
  const brushes = map.entities.filter((e) => ["worldspawn", "func_group"].includes(classname(e))).flatMap((e) => e.brushes);
  const sockets = map.entities.filter((e) => classname(e) === "prefab_socket").map((e) => ({
    name: getProp(e, "name") ?? getProp(e, "targetname") ?? "socket", origin: parseOrigin(e) ?? [0, 0, 0], angle: Number(getProp(e, "angle") ?? 0),
  }));
  const w = map.entities[0];
  let bounds: Bounds | null = null;
  for (const b of brushes) {
    const bb = brushBounds(b);
    if (!bb) continue;
    bounds = bounds ? { min: bounds.min.map((v, i) => Math.min(v, bb.min[i])) as Vec3, max: bounds.max.map((v, i) => Math.max(v, bb.max[i])) as Vec3 } : bb;
  }
  return { name: path.basename(file, ".map"), file, brushes, sockets, mount: getProp(w, "prefab_mount") ?? "floor", note: getProp(w, "prefab_note") ?? "", bounds };
}

export function listPrefabs(dir: string): Prefab[] {
  if (!fs.existsSync(dir)) throw new Error(`prefab library not found: ${dir}`);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".map")).sort().map((f) => loadPrefab(path.join(dir, f)));
}

// Bounds and planes per brush, computed once per brush object (a chapter has 36k brushes; vertices are not cheap).
const boundsCache = new WeakMap<Brush, Bounds | null>();
const planesCache = new WeakMap<Brush, { normal: Vec3; dist: number }[]>();
export function cachedBounds(b: Brush): Bounds | null {
  let v = boundsCache.get(b);
  if (v === undefined) { v = brushBounds(b); boundsCache.set(b, v); }
  return v;
}
function cachedPlanes(b: Brush) {
  let v = planesCache.get(b);
  if (!v) { v = b.faces.map((f) => planeFromPoints(f.points[0], f.points[1], f.points[2])); planesCache.set(b, v); }
  return v;
}

const rad = (d: number) => (d * Math.PI) / 180;
export function rotZ(p: Vec3, deg: number): Vec3 {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return [r(p[0] * c - p[1] * s), r(p[0] * s + p[1] * c), p[2]];
}
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** Ray against every solid brush of the map: nearest entry distance along a unit direction, with the face normal hit. */
export function raycast(map: MapFile, o: Vec3, d: Vec3, maxDist = 1e5, skip?: Set<Brush>): { t: number; normal: Vec3; entity: number; brush: number } | null {
  let best: { t: number; normal: Vec3; entity: number; brush: number } | null = null;
  map.entities.forEach((e, ei) => {
    if (!["worldspawn", "func_group"].includes(classname(e))) return;
    e.brushes.forEach((b, bi) => {
      if (skip?.has(b)) return;
      const bb = cachedBounds(b);
      if (!bb) return;
      // slab test on the box first
      let t0 = 0, t1 = best ? best.t : maxDist;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-12) { if (o[a] < bb.min[a] || o[a] > bb.max[a]) return; continue; }
        let ta = (bb.min[a] - o[a]) / d[a], tb = (bb.max[a] - o[a]) / d[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return;
      }
      // exact convex clip (Cyrus-Beck) against the brush planes
      let tin = -Infinity, tout = Infinity, nin: Vec3 = [0, 0, 0];
      for (const pl of cachedPlanes(b)) {
        const dn = pl.normal[0] * d[0] + pl.normal[1] * d[1] + pl.normal[2] * d[2];
        const dist = pl.dist - (pl.normal[0] * o[0] + pl.normal[1] * o[1] + pl.normal[2] * o[2]);
        if (Math.abs(dn) < 1e-12) { if (dist < -1e-6) return; continue; }
        const t = dist / dn;
        if (dn < 0) { if (t > tin) { tin = t; nin = pl.normal; } } else tout = Math.min(tout, t);
      }
      if (tin > tout || tout < 0) return;
      const t = Math.max(tin, 0);
      if (t <= maxDist && (!best || t < best.t)) best = { t, normal: nin, entity: ei, brush: bi };
    });
  });
  return best;
}

/** Brushes of the map that overlap any of `placed` with real volume (touching is fine). */
export function overlaps(map: MapFile, placed: Brush[], skip: Set<Brush>): { entity: number; brush: number; textures: string[] }[] {
  const out: { entity: number; brush: number; textures: string[] }[] = [];
  const ps = placed.map((b) => ({ s: solidFromBrush(b), bb: brushBounds(b)! }));
  const eps = 0.05;
  map.entities.forEach((e, ei) => {
    if (!["worldspawn", "func_group"].includes(classname(e))) return;
    e.brushes.forEach((b, bi) => {
      if (skip.has(b)) return;
      const bb = cachedBounds(b);
      if (!bb) return;
      for (const p of ps) {
        if ([0, 1, 2].some((a) => bb.max[a] <= p.bb.min[a] + eps || bb.min[a] >= p.bb.max[a] - eps)) continue;
        if (intersects(solidFromBrush(b), p.s)) { out.push({ entity: ei, brush: bi, textures: [...new Set(b.faces.map((f) => f.texture))] }); break; }
      }
    });
  });
  return out;
}

// .map values can't hold double quotes, so sockets ride as "name x y z angle; name x y z angle".
export function encodeSockets(list: Socket[]): string {
  return list.map((s) => [s.name.replace(/[;\s"]/g, "_"), ...s.origin, s.angle].join(" ")).join("; ");
}
export function decodeSockets(text: string): Socket[] {
  return text.split(";").map((t) => t.trim().split(/\s+/)).filter((p) => p.length === 5)
    .map(([name, x, y, z, a]) => ({ name, origin: [Number(x), Number(y), Number(z)] as Vec3, angle: Number(a) }));
}

export function placedSockets(map: MapFile): { group: number; name: string; sockets: Socket[] }[] {
  return map.entities.flatMap((e, i) => {
    const s = getProp(e, "_prefab_sockets");
    return s ? [{ group: i, name: getProp(e, "_tb_name") ?? "", sockets: decodeSockets(s) }] : [];
  });
}

export interface Placement { origin: Vec3; yaw: number }

/** Where to put a prefab so its socket `mine` meets `target` facing it. */
export function snapToSocket(p: Prefab, mine: string, target: Socket): Placement {
  const s = p.sockets.find((x) => x.name === mine);
  if (!s) throw new Error(`prefab ${p.name} has no socket "${mine}" (has: ${p.sockets.map((x) => x.name).join(", ") || "none"})`);
  const yaw = norm360(target.angle + 180 - s.angle);
  const at = rotZ(s.origin, yaw);
  return { origin: [target.origin[0] - at[0], target.origin[1] - at[1], target.origin[2] - at[2]], yaw };
}

/** Instance brushes and sockets for a placement. */
export function instance(p: Prefab, pl: Placement): { brushes: Brush[]; sockets: Socket[] } {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const brushes = p.brushes.map((b) => {
    const t = transformBrush(b, pl.yaw, pl.origin, [0, 0, 0]);
    for (const f of t.faces) f.points = f.points.map((q) => q.map(r3)) as [Vec3, Vec3, Vec3];   // no 1e-16 noise from cos(90)
    return t;
  });
  const sockets = p.sockets.map((s) => ({ name: s.name, origin: add(rotZ(s.origin, pl.yaw), pl.origin).map((v) => Math.round(v * 1000) / 1000) as Vec3, angle: norm360(s.angle + pl.yaw) }));
  return { brushes, sockets };
}

export function groupEntity(map: MapFile, name: string, prefab: string, brushes: Brush[], sockets: Socket[], layer?: string): Entity {
  const id = Math.max(0, ...map.entities.map((e) => Number(getProp(e, "_tb_id") ?? 0))) + 1;
  const props = [
    { key: "classname", value: "func_group" }, { key: "_tb_type", value: "_tb_group" },
    { key: "_tb_name", value: name }, { key: "_tb_id", value: String(id) },
    { key: "_prefab", value: prefab }, { key: "_prefab_sockets", value: encodeSockets(sockets) },
  ];
  if (layer !== undefined) props.push({ key: "_tb_layer", value: layer });
  return { properties: props, brushes };
}

/** Heightfield terrain the .map does not contain, from a project sidecar (map coordinates; see tbmcp.json "terrain"). */
export interface Terrain { origin: [number, number]; cell: [number, number]; nx: number; ny: number; z: number[] }

export function terrainHeight(t: Terrain, x: number, y: number): number | null {
  const gx = (x - t.origin[0]) / t.cell[0], gy = (y - t.origin[1]) / t.cell[1];
  if (gx < 0 || gy < 0 || gx > t.nx - 1 || gy > t.ny - 1) return null;
  const i = Math.min(Math.floor(gx), t.nx - 2), j = Math.min(Math.floor(gy), t.ny - 2), u = gx - i, v = gy - j;
  const h = (a: number, b: number) => t.z[a + t.nx * b];
  return h(i, j) * (1 - u) * (1 - v) + h(i + 1, j) * u * (1 - v) + h(i, j + 1) * (1 - u) * v + h(i + 1, j + 1) * u * v;   // bilinear: within a few cm of the game's triangles
}

/** Highest surface (brush top or terrain) below a point, or null. */
export function groundBelow(map: MapFile, terrain: Terrain | null, p: Vec3): { z: number; on: string } | null {
  const hit = raycast(map, p, [0, 0, -1]);
  const bz = hit ? p[2] - hit.t : -Infinity;
  const tz = terrain ? terrainHeight(terrain, p[0], p[1]) : null;
  if (tz !== null && tz <= p[2] + 1e-6 && tz > bz) return { z: tz, on: "terrain" };
  return hit ? { z: bz, on: `brush ${hit.entity}/${hit.brush}` } : null;
}
