import test from "node:test";
import assert from "node:assert/strict";
import { wedgeSolid, boxSolid, prismSolid, solidVolume, subtract, bevelSolid, brushFromSolid, solidFromBrush, polygons, rotateBrush, rotationMatrix, split, planeThrough } from "../dist/map/csg.js";
import { parseMap } from "../dist/map/parser.js";
import { serializeMap } from "../dist/map/writer.js";
import { brushBounds } from "../dist/map/geometry.js";

const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test("wedge is half a box, with 5 faces", () => {
  const w = wedgeSolid([0, 0, 0], [64, 32, 16], "+x", "t", true);
  near(solidVolume(w), 64 * 32 * 16 / 2);
  assert.equal(polygons(w).length, 5);
});

test("subtract box conserves volume", () => {
  const a = boxSolid([0, 0, 0], [64, 64, 64], "t", true);
  const cut = boxSolid([16, 16, -8], [48, 48, 40], "t", true);
  const pieces = subtract(a, cut);
  const total = pieces.reduce((s, p) => s + solidVolume(p), 0);
  near(total, 64 ** 3 - 32 * 32 * 40, 0.1);
});

test("octagonal prism then clip keeps valid brush and round-trips through the writer", () => {
  const poly = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4) * 32, Math.sin(i * Math.PI / 4) * 32]);
  const p = prismSolid(poly, 0, 64, "t", true);
  const { back } = split(p, planeThrough([0, 0, 1], [0, 0, 32]));
  near(solidVolume(back), solidVolume(p) / 2, 0.1);
  const brush = brushFromSolid(back, "cut", true);
  const map = parseMap(serializeMap({ header: ["// Game: Quake"], eol: "\n", entities: [{ properties: [{ key: "classname", value: "worldspawn" }], brushes: [brush] }] }));
  near(solidVolume(solidFromBrush(map.entities[0].brushes[0])), solidVolume(back), 0.1);
});

test("bevel removes volume and adds faces; rotation keeps volume", () => {
  const b = boxSolid([0, 0, 0], [32, 32, 32], "t", true);
  const v = bevelSolid(b, 4, "t", true);
  assert.ok(solidVolume(v) < solidVolume(b));
  assert.equal(polygons(v).length, 6 + 12);
  const brush = brushFromSolid(b, "t", true);
  const before = solidVolume(solidFromBrush(brush));
  rotateBrush(brush, rotationMatrix("z", 33), [16, 16, 16]);
  near(solidVolume(solidFromBrush(brush)), before, 0.5);
  const bb = brushBounds(brush);
  assert.ok(bb.max[0] - bb.min[0] > 32);
});
