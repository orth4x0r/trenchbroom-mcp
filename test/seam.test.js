import test from "node:test";
import assert from "node:assert/strict";
import { parseMap } from "../dist/map/parser.js";
import { makeBoxBrush } from "../dist/map/builder.js";
import { planLips } from "../dist/seam.js";

const world = () => parseMap('// Game: Quake\n// Format: Valve\n{\n"classname" "worldspawn"\n"mapversion" "220"\n}\n');
// ground rising along +y: z = y / 16 (cells 16 units), over x,y in 0..256
const slope = () => {
  const nx = 17, ny = 17, z = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z.push(j);
  return { origin: [0, 0], cell: [16, 16], nx, ny, z };
};
const O = { height: 3, depth: 2, bury: 4, segment: 16, minHeight: 16 };

test("seam: a wall standing in sloped ground gets kerbs on its four sides, tops following the ground", () => {
  const m = world();
  m.entities[0].brushes.push(makeBoxBrush([64, 64, -16], [128, 160, 96], "wall", true));
  const { lips, brushes } = planLips(m, slope(), O, () => false);
  assert.equal(brushes, 1);
  assert.deepEqual([...new Set(lips.map((l) => l.side))].sort(), ["+x", "+y", "-x", "-y"]);
  // the +x kerb runs along y over a constant slope: one merged piece whose top climbs with the ground
  const px = lips.filter((l) => l.side === "+x");
  assert.equal(px.length, 1);
  assert.deepEqual([px[0].min[1], px[0].max[1]], [64, 160]);
  assert.ok(Math.abs(px[0].top[0] - (64 / 16 + 3)) < 1e-6 && Math.abs(px[0].top[1] - (160 / 16 + 3)) < 1e-6);
  assert.ok(px[0].min[2] <= 64 / 16 - 4 + 1e-6);   // buried below the lowest ground
  assert.deepEqual([px[0].min[0], px[0].max[0]], [128, 130]);
  // y-facing kerbs run past the corners
  const py = lips.find((l) => l.side === "+y");
  assert.deepEqual([py.min[0], py.max[0]], [62, 130]);
  assert.equal(py.texture, "wall");
});

test("seam: no kerb on a side that faces another brush, on a floating brush, on a slab, or in the lip layer", () => {
  const m = world();
  m.entities[0].brushes.push(
    makeBoxBrush([64, 64, -16], [128, 160, 96], "wall", true),
    makeBoxBrush([128, 64, -16], [192, 160, 96], "wall", true),   // flush against +x
    makeBoxBrush([0, 200, 40], [32, 232, 96], "wall", true),      // floats above the ground
    makeBoxBrush([200, 0, -4], [240, 40, 8], "slab", true),       // too short
  );
  const { lips } = planLips(m, slope(), O, () => false);
  assert.ok(!lips.some((l) => l.from.brush === 0 && l.side === "+x"));
  assert.ok(!lips.some((l) => l.from.brush === 1 && l.side === "-x"));
  assert.ok(!lips.some((l) => l.from.brush === 2 || l.from.brush === 3));
  const skip = planLips(m, slope(), { ...O, skipTextures: ["wall"] }, () => false);
  assert.equal(skip.lips.length, 0);
});
