import type { Brush, Entity, MapFile } from "./model.js";
import { classname, getProp } from "./model.js";
import { brushBounds, planeFromPoints } from "./geometry.js";

/**
 * Geometric diff of two maps, for agents that need to know what their edits changed.
 *
 * A brush is identified by its planes (normal to 1e-4, distance to 1e-3 units) and their textures, sorted, plus the
 * layer kind it sits in, so re-saving in TrenchBroom, reordering brushes, or reformatting numbers is not a change.
 * Texture alignment is ignored on purpose (it does not change what a level plays like). Point and brush entities are
 * matched by a key property (default "id", then "targetname"); worldspawn and TrenchBroom layer/group entities count
 * as world geometry.
 */

export interface BrushRef {
  entity: number;
  brush: number;
  layer: string | null;
  min: number[];
  max: number[];
  textures: string[];
}

export interface EntityChange {
  key: string;
  classname: string;
  index: number;
  changed: { property: string; before: string | null; after: string | null }[];
  brushesChanged: boolean;
}

export interface MapDiff {
  brushesAdded: BrushRef[];
  brushesRemoved: BrushRef[];
  entitiesAdded: { key: string; classname: string; index: number }[];
  entitiesRemoved: { key: string; classname: string; index: number }[];
  entitiesChanged: EntityChange[];
  unkeyedEntities: number;
}

const WORLD = new Set(["worldspawn", "func_group"]);

function round(x: number, q: number): string {
  const v = Math.round(x / q) * q;
  const s = v.toFixed(q < 1e-3 ? 4 : 3);
  return s.startsWith("-") && Number(s) === 0 ? s.slice(1) : s;
}

export function brushKey(b: Brush): string {
  return b.faces
    .map((f) => {
      const p = planeFromPoints(f.points[0], f.points[1], f.points[2]);
      return `${p.normal.map((x) => round(x, 1e-4)).join(",")}@${round(p.dist, 1e-3)}:${f.texture}`;
    })
    .sort()
    .join(";");
}

function layerName(map: MapFile, e: Entity): string | null {
  if (getProp(e, "_tb_type") === "_tb_layer") return getProp(e, "_tb_name") ?? "(layer)";
  const id = getProp(e, "_tb_layer");
  if (id === undefined) return null;
  const layer = map.entities.find((x) => getProp(x, "_tb_type") === "_tb_layer" && getProp(x, "_tb_id") === id);
  return layer ? getProp(layer, "_tb_name") ?? "(layer)" : null;
}

function worldBrushes(map: MapFile): { ref: BrushRef; key: string }[] {
  const out: { ref: BrushRef; key: string }[] = [];
  map.entities.forEach((e, ei) => {
    if (!WORLD.has(classname(e))) return;
    const layer = layerName(map, e);
    e.brushes.forEach((b, bi) => {
      const bb = brushBounds(b);
      out.push({
        key: `${layer ?? ""}|${brushKey(b)}`,
        ref: { entity: ei, brush: bi, layer, min: bb ? bb.min : [], max: bb ? bb.max : [], textures: [...new Set(b.faces.map((f) => f.texture))] },
      });
    });
  });
  return out;
}

export function diffMaps(before: MapFile, after: MapFile, keyProp = "id"): MapDiff {
  const count = new Map<string, number>();
  for (const { key } of worldBrushes(before)) count.set(key, (count.get(key) ?? 0) + 1);
  const brushesAdded: BrushRef[] = [];
  for (const { key, ref } of worldBrushes(after)) {
    const n = count.get(key) ?? 0;
    if (n > 0) count.set(key, n - 1);
    else brushesAdded.push(ref);
  }
  // What is left in `count` was removed; recover the refs in order.
  const brushesRemoved: BrushRef[] = [];
  for (const { key, ref } of worldBrushes(before)) {
    const n = count.get(key) ?? 0;
    if (n > 0) { brushesRemoved.push(ref); count.set(key, n - 1); }
  }

  let unkeyed = 0;
  const keyed = (map: MapFile) => {
    const m = new Map<string, { e: Entity; index: number }>();
    map.entities.forEach((e, index) => {
      const cls = classname(e);
      if (WORLD.has(cls)) return;
      const k = getProp(e, keyProp) ?? getProp(e, "targetname");
      if (k === undefined) { unkeyed++; return; }
      m.set(`${cls}:${k}`, { e, index });
    });
    return m;
  };
  const A = keyed(before), B = keyed(after);
  const entitiesAdded = [...B].filter(([k]) => !A.has(k)).map(([k, v]) => ({ key: k, classname: classname(v.e), index: v.index }));
  const entitiesRemoved = [...A].filter(([k]) => !B.has(k)).map(([k, v]) => ({ key: k, classname: classname(v.e), index: v.index }));
  const entitiesChanged: EntityChange[] = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const props = new Set([...a.e.properties, ...b.e.properties].map((p) => p.key).filter((p) => !p.startsWith("_tb_")));
    const changed = [...props]
      .map((p) => ({ property: p, before: getProp(a.e, p) ?? null, after: getProp(b.e, p) ?? null }))
      .filter((c) => c.before !== c.after);
    const keysA = a.e.brushes.map(brushKey).sort().join("|"), keysB = b.e.brushes.map(brushKey).sort().join("|");
    if (changed.length || keysA !== keysB) entitiesChanged.push({ key: k, classname: classname(b.e), index: b.index, changed, brushesChanged: keysA !== keysB });
  }
  return { brushesAdded, brushesRemoved, entitiesAdded, entitiesRemoved, entitiesChanged, unkeyedEntities: unkeyed };
}
