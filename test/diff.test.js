import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMap } from "../dist/map/parser.js";
import { serializeMap } from "../dist/map/writer.js";
import { setProp } from "../dist/map/model.js";
import { makeBoxBrush, translateEntity } from "../dist/map/builder.js";
import { diffMaps } from "../dist/map/diff.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "example.map"), "utf8");

test("diff: a map against itself, and against a re-saved and reordered copy, is empty", () => {
  const a = parseMap(fixture);
  const b = parseMap(serializeMap(parseMap(fixture)));
  b.entities[0].brushes[0].faces.reverse();
  const d = diffMaps(a, b);
  assert.equal(d.brushesAdded.length + d.brushesRemoved.length + d.entitiesChanged.length + d.entitiesAdded.length + d.entitiesRemoved.length, 0);
});

test("diff: added and removed brushes, moved entity, changed property", () => {
  const a = parseMap(fixture);
  const b = parseMap(fixture);
  b.entities[0].brushes.push(makeBoxBrush([0, 0, 0], [64, 64, 64], "NEW", true));
  const moved = b.entities[0].brushes.shift();
  b.entities[0].brushes.push(makeBoxBrush([1000, 0, 0], [1064, 64, 64], moved.faces[0].texture, true));
  translateEntity(b.entities[3], [0, 0, 16]);   // the func_door "door1": its brushes move
  setProp(b.entities[3], "speed", "200");
  const d = diffMaps(a, b, "targetname");
  assert.equal(d.brushesAdded.length, 2);
  assert.equal(d.brushesRemoved.length, 1);
  assert.deepEqual(d.brushesRemoved[0].min.length, 3);
  assert.equal(d.entitiesChanged.length, 1);
  assert.equal(d.entitiesChanged[0].key, "func_door:door1");
  assert.ok(d.entitiesChanged[0].brushesChanged);
  assert.deepEqual(d.entitiesChanged[0].changed.map((c) => c.property), ["speed"]);
  assert.equal(d.unkeyedEntities, 4);   // light and info_player_start, in both maps
});
