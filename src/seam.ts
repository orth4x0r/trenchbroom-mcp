import type { Brush, Entity, MapFile, Vec3 } from "./map/model.js";
import { classname, getProp } from "./map/model.js";
import { BrushGrid, cachedBounds, cachedPlanes, terrainHeight, type Terrain } from "./prefab.js";

/**
 * Seam lips: where a brush wall meets heightfield terrain the .map can't see, the contact is a hard straight line on
 * a bumpy ground. A real builder pours a plinth: a low kerb hugging the wall that buries itself in the ground and
 * steps with it. This plans those kerbs as boxes: along each exposed side of each brush the terrain crosses, in
 * terrain-cell segments, from `bury` below the lowest ground to `height` above the highest, `depth` out from the wall.
 * Sides facing another brush (not exposed) and brushes standing above the ground or sunk below it are skipped;
 * pieces on one slope merge. The top slopes with the ground. Y-facing kerbs run past the corners so corners close without overlap.
 */

export interface LipOptions { height: number; depth: number; bury: number; segment: number; minHeight: number; skipTextures?: string[]; region?: { min: [number, number]; max: [number, number] } }
export interface LipBox { min: Vec3; max: Vec3; side: "+x" | "-x" | "+y" | "-y"; from: { entity: number; brush: number }; texture: string; /** top z at min and max of the run (along the wall) */ top: [number, number] }

export function planLips(map: MapFile, t: Terrain, o: LipOptions, isLip: (e: Entity) => boolean): { lips: LipBox[]; brushes: number; sides: number } {
  const grid = new BrushGrid(map, 64, isLip);
  const lips: LipBox[] = [];
  let brushes = 0, sides = 0;
  map.entities.forEach((e, ei) => {
    if (!["worldspawn", "func_group"].includes(classname(e)) || isLip(e)) return;
    if (/^visual/i.test(layerOf(map, e) ?? "")) return;   // render-only dressing doesn't meet the ground as architecture
    e.brushes.forEach((b, bi) => {
      const bb = cachedBounds(b);
      if (!bb) return;
      if (o.region && (bb.max[0] < o.region.min[0] || bb.min[0] > o.region.max[0] || bb.max[1] < o.region.min[1] || bb.min[1] > o.region.max[1])) return;
      if (bb.max[2] - bb.min[2] < o.minHeight) return;   // slabs and kerbs: nothing to plinth
      let any = false;
      for (const side of ["+x", "-x", "+y", "-y"] as const) {
        const axis = side[1] === "x" ? 0 : 1, other = 1 - axis, sgn = side[0] === "+" ? 1 : -1;
        const plane = sgn > 0 ? bb.max[axis] : bb.min[axis];
        // only a real axis-aligned wall face on this side gets a kerb (rotated or sloped brushes would leave it floating)
        const fi = cachedPlanes(b).findIndex((pl) => Math.abs(pl.normal[axis] - sgn) < 1e-3 && Math.abs(pl.dist - sgn * plane) < 0.05);
        if (fi < 0 || o.skipTextures?.includes(b.faces[fi].texture)) continue;
        const texture = b.faces[fi].texture;
        // y-facing kerbs cover the corners (run `depth` past each end); x-facing ones stop at the brush
        const lo = bb.min[other] - (axis === 0 ? 0 : o.depth), hi = bb.max[other] + (axis === 0 ? 0 : o.depth);
        let run: LipBox | null = null;
        for (let s = lo; s < hi - 1e-6; s += o.segment) {
          const s1 = Math.min(s + o.segment, hi);
          const at = (u: number, off: number): [number, number] => {
            const p: [number, number] = [0, 0];
            p[axis] = plane + sgn * off; p[other] = u;
            return p;
          };
          const at3 = [s, (s + s1) / 2, s1].map((u) => [0.5, o.depth].map((off) => { const q = at(u, off); return terrainHeight(t, q[0], q[1]); }));
          const hs = at3.flat();
          if (hs.some((h) => h === null)) { run = null; continue; }
          const tmin = Math.min(...(hs as number[])), tmax = Math.max(...(hs as number[]));
          // the wall must actually stand in the ground here: bottom at or below it, top well above it
          if (bb.min[2] > tmin + 1 || bb.max[2] < tmax + o.height * 2) { run = null; continue; }
          // exposed: just outside the wall, a little above the ground, is open space
          const m = at((s + s1) / 2, o.depth / 2);
          if (grid.inside([m[0], m[1], tmax + o.height / 2])) { run = null; continue; }
          // the top follows the ground along the wall (a sloped kerb, not a staircase of boxes), `height` clear of it at
          // each segment end, so neighbouring pieces meet flush
          const hi3 = at3.map((pair) => Math.max(...(pair as number[])) + o.height);
          const top: [number, number] = [hi3[0], hi3[2]];
          const zmin = tmin - o.bury;
          const min: Vec3 = [0, 0, zmin], max: Vec3 = [0, 0, Math.max(...top)];
          min[axis] = sgn > 0 ? plane : plane - o.depth; max[axis] = sgn > 0 ? plane + o.depth : plane;
          min[other] = s; max[other] = s1;
          const slope = (top[1] - top[0]) / (s1 - s);
          if (run && Math.abs(run.max[other] - s) < 1e-6 && Math.abs(run.top[1] - top[0]) < 0.5
            && Math.abs((run.top[1] - run.top[0]) / (run.max[other] - run.min[other]) - slope) * o.segment < 0.75) {
            run.max[other] = s1; run.top[1] = top[1]; run.min[2] = Math.min(run.min[2], zmin); run.max[2] = Math.max(run.max[2], max[2]);
          } else {
            run = { min, max, top, side, from: { entity: ei, brush: bi }, texture };
            lips.push(run);
          }
          any = true; sides++;
        }
      }
      if (any) brushes++;
    });
  });
  return { lips, brushes, sides };
}

function layerOf(map: MapFile, e: Entity): string | undefined {
  if (getProp(e, "_tb_type") === "_tb_layer") return getProp(e, "_tb_name");
  const id = getProp(e, "_tb_layer");
  if (id === undefined) return undefined;
  const l = map.entities.find((x) => getProp(x, "_tb_type") === "_tb_layer" && getProp(x, "_tb_id") === id);
  return l ? getProp(l, "_tb_name") : undefined;
}

export type { Brush };
