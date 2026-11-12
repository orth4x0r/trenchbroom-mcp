import test from "node:test";
import assert from "node:assert/strict";
import { parseMap } from "../dist/map/parser.js";
import { makeBoxBrush } from "../dist/map/builder.js";
import { decodeSockets, encodeSockets, instance, overlaps, raycast, snapToSocket, terrainHeight, groundBelow } from "../dist/prefab.js";

const world = () => parseMap('// Game: Quake\n// Format: Valve\n{\n"classname" "worldspawn"\n"mapversion" "220"\n}\n');

test("prefab: socket join puts the sockets on one point, facing each other", () => {
  const p = { name: "cw", brushes: [], sockets: [{ name: "a", origin: [0, 0, 32], angle: 180 }, { name: "b", origin: [64, 0, 32], angle: 0 }], mount: "floor", note: "", bounds: null };
  const target = { name: "n", origin: [100, 200, 40], angle: 90 };
  const pl = snapToSocket(p, "a", target);
  const inst = instance(p, pl);
  const a = inst.sockets.find((s) => s.name === "a");
  assert.deepEqual(a.origin, [100, 200, 40]);
  assert.equal(a.angle, 270);   // opposite the target's 90
  assert.deepEqual(inst.sockets.find((s) => s.name === "b").origin, [100, 264, 40]);
});

test("prefab: sockets survive the .map value encoding (no double quotes)", () => {
  const s = [{ name: "top", origin: [1.5, -2, 3], angle: 90 }, { name: "foot", origin: [0, 0, 0], angle: 270 }];
  const text = encodeSockets(s);
  assert.ok(!text.includes('"'));
  assert.deepEqual(decodeSockets(text), s);
});

test("prefab: raycast finds the near face; overlap ignores touching", () => {
  const m = world();
  m.entities[0].brushes.push(makeBoxBrush([0, 0, 0], [64, 64, 8], "floor", true), makeBoxBrush([64, 0, 0], [72, 64, 64], "wall", true));
  const down = raycast(m, [32, 32, 40], [0, 0, -1]);
  assert.equal(Math.round(down.t), 32);
  const side = raycast(m, [32, 32, 20], [1, 0, 0]);
  assert.equal(Math.round(side.t), 32);
  assert.deepEqual(side.normal.map(Math.round), [-1, 0, 0]);
  assert.equal(overlaps(m, [makeBoxBrush([0, 0, 8], [16, 16, 24], "x", true)], new Set()).length, 0);   // sits on the floor
  assert.equal(overlaps(m, [makeBoxBrush([0, 0, 4], [16, 16, 24], "x", true)], new Set()).length, 1);   // sinks into it
});

test("prefab: terrain height and the highest ground below", () => {
  const t = { origin: [0, 160], cell: [16, -16], nx: 3, ny: 3, z: [0, 0, 0, 16, 16, 16, 32, 32, 32] };
  assert.equal(terrainHeight(t, 8, 160), 0);
  assert.equal(terrainHeight(t, 8, 144), 16);
  assert.equal(terrainHeight(t, 8, 136), 24);
  assert.equal(terrainHeight(t, 100, 100), null);
  const m = world();
  m.entities[0].brushes.push(makeBoxBrush([0, 120, 0], [32, 160, 20], "slab", true));
  assert.equal(groundBelow(m, t, [8, 144, 100]).on.startsWith("brush"), true);   // slab top 20 above terrain 16
  assert.equal(groundBelow(m, t, [8, 136, 100]).on, "terrain");                   // terrain 24 above slab top 20
});
