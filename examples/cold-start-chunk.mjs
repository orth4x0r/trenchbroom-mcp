#!/usr/bin/env node
// Gate test: rebuild a real chunk of Cold Start (Maintenance Bay, Service Corridor, Loading Docks entry)
// purely through MCP tool calls. No hand edits, no direct file writes except through the server.
//   node examples/cold-start-chunk.mjs /abs/out.map
// Level metres -> map units: x*U, (SZ - z)*U, y*U  (matches godot/tools/map-level.mjs, U = 8, SZ = 272).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const out = process.argv[2];
const TRIM = process.env.TRIM_LAYER ?? "Visual trim"; // "none", "Trim" (collidable) or a "Visual ..." layer (render only)
if (!out) throw new Error("usage: cold-start-chunk.mjs /abs/out.map");
const U = 8, SZ = 272;
const P = (x, y, z) => [x * U, (SZ - z) * U, y * U];               // level point -> map point
const BOX = (x, y, z, w, h, d) => {                                  // level box -> map min/max
  const a = P(x, y, z), b = P(x + w, y + h, z + d);
  return { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] };
};

fs.writeFileSync(out, `// Game: Quake\n// Format: Valve\n// entity 0\n{\n"classname" "worldspawn"\n"mapversion" "220"\n"level_size" "400 128 272"\n"level_units" "${U}"\n}\n`);

const client = new Client({ name: "cold-start-chunk", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
let calls = 0;
const call = async (name, args) => {
  calls++;
  const r = await client.callTool({ name, arguments: { map_path: out, ...args } });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const box = (x, y, z, w, h, d, texture) => call("add_brush_box", { ...BOX(x, y, z, w, h, d), texture });
const cut = (x, y, z, w, h, d, tex = "cast_concrete") => call("subtract_box", { ...BOX(x, y, z, w, h, d), cut_texture: tex });
// A solid mass then hollowed: a room with 1 m walls, floor and ceiling.
const room = async (x, y, z, w, h, d, tex, mats = {}) => {
  const r = await box(x - 1, y - 1, z - 1, w + 2, h + 2, d + 2, tex);
  const hol = await call("hollow_brush", { entity_index: 0, brush_index: r.brushIndex, wall: U, inner_texture: tex });
  // Per-face materials: the floor slab gets the floor texture on top, the ceiling slab gets its own underneath,
  // and a base trim runs round the foot of the walls.
  const list = await call("list_brushes", { entity_index: 0 });
  const mine = list.slice(r.brushIndex, r.brushIndex + hol.walls);
  const zin = [BOX(x, y, z, w, h, d).min[2], BOX(x, y, z, w, h, d).max[2]];
  for (const b of mine) {
    if (mats.floor && Math.abs(b.max[2] - zin[0]) < 0.01) await call("set_face_texture", { entity_index: 0, brush_index: b.index, faces: "+z", texture: mats.floor });
    if (mats.ceil && Math.abs(b.min[2] - zin[1]) < 0.01) await call("set_face_texture", { entity_index: 0, brush_index: b.index, faces: "-z", texture: mats.ceil });
  }
};

// A / Maintenance Bay
await room(12, 1, 8, 22, 7, 16, "wall_panel", { floor: "cast_concrete", ceil: "plate_steel" });
const bayIn = BOX(12, 1, 8, 22, 7, 16);
if (TRIM !== "none") await call("add_room_trim", { layer: TRIM, ...bayIn, base_height: 0.3 * U, cornice_height: 0.3 * U, depth: 0.15 * U, rib_every: 4 * U, rib_width: 0.4 * U, pilasters: true, base_texture: "trim_wall_base", rib_texture: "plate_steel_b", bevel: 0.05 * U, openings: [BOX(33, 1, 14, 2, 4, 4)] });
await box(12, 1, 8, 22, 3, 2, "plate_steel"); await box(12, 1, 22, 10, 2, 2, "painted_steel");
await box(26, 1, 20, 4, 1, 4, "mesh_grate"); await box(28, 2, 21, 2, 1, 3, "mesh_grate");
await call("add_entity", { classname: "info_player_start", origin: P(17, 1.02, 16), properties: { angle: "90" } });
await call("add_entity", { classname: "light", origin: P(22, 7, 16), properties: { light: "300", _color: "0.9 0.72 0.45" } });

// B / Service Corridor with pipe racks, an arched mouth, a hazard-striped floor strip
await room(35, 1, 13, 36, 6, 6, "plate_steel", { floor: "mesh_grate", ceil: "wall_panel" });
const corIn = BOX(35, 1, 13, 36, 6, 6);
if (TRIM !== "none") await call("add_room_trim", { layer: TRIM, ...corIn, base_height: 0.3 * U, cornice_height: 0.3 * U, depth: 0.12 * U, rib_every: 4 * U, rib_width: 0.35 * U, base_texture: "trim_wall_base", rib_texture: "plate_steel_b", bevel: 0.04 * U, openings: [BOX(34, 1, 14, 2, 4, 4), BOX(70, 1, 14, 2, 5, 4)] });
await cut(34, 1, 14, 1, 4, 4);                                         // doorway from the bay
await call("add_arch", { center: P(34.5, 1 + 2.5, 16), axis: "y", inner: 2 * U, outer: 2.6 * U, depth: 1 * U, segments: 8, texture: "orange_trim" });
for (const z of [14.2, 17.8]) await call("add_pipe", { from: P(35, 5, z), to: P(71, 5, z), radius: 0.35 * U, sides: 8, texture: "rusty_pipe" });
await box(46, 1, 13, 2, 2, 2, "rust_plate"); await box(58, 1, 17, 2, 2, 2, "rust_plate");
await box(64, 1, 13, 4, 1, 2, "plate_steel");

// C / Loading Docks entry: open yard walls, a long dock slab with warning trim, containers, ramp, stairs, catwalk, pillars
await box(72, 0, 5, 64, 1, 52, "asphalt");
await box(76, 1, 6, 56, 2, 8, "cast_concrete_b"); await box(76, 3, 6, 56, 1, 1, "warning");
await cut(71, 1, 14, 1, 5, 4);
await call("add_brush_wedge", { ...BOX(80, 1, 14, 10, 2, 5), high: "+y", texture: "cast_concrete_b" });
await call("add_stairs", { ...BOX(110, 1, 40, 6, 3, 4), high: "+x", steps: 6, texture: "cast_concrete_b" });
for (const [x, z, y] of [[88, 24, 1], [88, 24, 4]]) await box(x, y, z, 6, 3, 2.4, y === 1 ? "painted_steel" : "rust_plate");
await box(100, 1, 34, 2.4, 3, 6, "corrugated"); await box(94, 1, 44, 6, 3, 2.4, "rust_plate");
await call("add_catwalk", { from: P(76, 8, 32), to: P(122, 8, 32), width: 2 * U, thickness: 0.4 * U, rail_height: 1 * U, rail_size: 0.15 * U, leg_every: 12 * U, leg_size: 0.4 * U, floor_z: 1 * U, deck_texture: "grate", rail_texture: "orange_trim" });
for (const x of [76, 120]) await call("add_brush_hull", { points: [ [x, 1, 24], [x + 2, 1, 24], [x, 1, 26], [x + 2, 1, 26], [x + 0.3, 24, 24.3], [x + 1.7, 24, 24.3], [x + 0.3, 24, 25.7], [x + 1.7, 24, 25.7] ].map(([a, b, c]) => P(a, b, c)), texture: "orange_trim" });
await call("add_brush_cylinder", { center: [P(104, 1, 12)[0], P(104, 1, 12)[1]], radius: 1.2 * U, z_min: 1 * U, z_max: 9 * U, sides: 8, texture: "plate_steel" });
await box(135, 9, 42, 1, 9, 12, "plate_steel"); await box(135, 8, 42, 1, 1, 12, "reactor");


// ---- Dressing for parity with the hand-built original: light panels, hazard edges, pipe/vent bands, machines.
// Visual-only (layer name starts with "Visual"): the converter marks these render-only, so no physics cost.
const dl = await call("add_layer", { name: "Visual dressing" });
const dressed = [];
const dbox = async (x, y, z, w, h, d, tex) => { const r = await box(x, y, z, w, h, d, tex); dressed.push(r.brushIndex); };
for (const x of [14, 20, 26, 31]) await dbox(x, 7.7, 10, 2, 0.3, 12, "light_panel");        // bay ceiling light strips
for (let x = 38; x < 70; x += 6) await dbox(x, 6.7, 15, 2, 0.3, 2, "light_panel");           // corridor ceiling lights
for (const z of [13, 18.2]) await dbox(35, 1, z, 36, 0.12, 0.8, "trim_hazard_edge");         // hazard edges along the corridor floor
for (const z of [13.15, 18.75]) await dbox(35, 3.2, z, 36, 0.3, 0.12, "trim_pipe_band");     // pipe band on both corridor walls
await dbox(12.1, 4.2, 10, 0.3, 1.2, 8, "vent_grille");                                       // bay wall vent bank
await dbox(30, 1, 9, 3, 2.4, 2, "machine");                                                  // bay machine
await dbox(15, 1, 22, 4, 2.2, 1, "archive_drawers");                                         // archive drawers
await dbox(33, 3.4, 14, 0.12, 0.3, 4, "trim_door_frame");                                    // door-head trim
// Parity pass 2: the original's three alcove portals (frame + machine) along the corridor, bay hazard pad, overhead pipe runs.
for (const [x, z] of [[43, 19], [63, 19], [54, 12]]) {
  await dbox(x, 1, z, 1, 5, 1, "trim_door_frame"); await dbox(x + 4, 1, z, 1, 5, 1, "trim_door_frame");
  await dbox(x + 1, 5, z, 3, 1, 1, "trim_door_frame"); await dbox(x + 1, 1, z, 3, 0.4, 1, "trim_door_frame");
  if (z === 19) await dbox(x + 1, 2, z + 0.4, 3, 3, 0.6, "machine");
}
await dbox(15, 1, 14, 5, 0.12, 5, "trim_hazard_edge");                                        // bay hazard pad
for (const z of [8.5, 23.5]) await dbox(12, 5, z, 22, 0.8, 0.8, "rusty_pipe");                // bay overhead pipe runs
await dbox(23, 5, 8.5, 0.8, 0.8, 15, "rusty_pipe");
await dbox(34, 4.5, 14, 1, 1, 4, "hazard_red");                                               // hazard header over the corridor mouth
await call("move_to_layer", { layer_entity: dl.entity, brush_indices: dressed });

// Rubble mounds (collidable rock hulls, like the original's): a low pile of two stacked hulls each.
for (const [x, z, w, d, h] of [[48.7, 13.7, 4.6, 4.8, 1.2], [56.5, 15.2, 3.4, 3.2, 0.9], [26.5, 10, 3, 3, 0.8]]) {
  const pts = [[x, 1, z], [x + w, 1, z], [x, 1, z + d], [x + w, 1, z + d], [x + w * 0.3, 1 + h, z + d * 0.3], [x + w * 0.7, 1 + h, z + d * 0.3], [x + w * 0.3, 1 + h, z + d * 0.7], [x + w * 0.7, 1 + h * 0.8, z + d * 0.7]];
  await call("add_brush_hull", { points: pts.map(([a, b, c]) => P(a, b, c)), texture: "rock" });
}

// Group the dock containers, bevel the quota board for a lip, array some ribs along the corridor wall.
const ov = await call("map_overview", {});
const rib = await box(37, 1, 13.2, 0.6, 5, 0.6, "plate_steel_b");
await call("clone_brushes", { entity_index: 0, brush_indices: [rib.brushIndex], count: 8, offset: [4 * U, 0, 0] });
const v = await call("validate_map", { materials_path: process.env.MATERIALS });
console.log(JSON.stringify({ toolCalls: calls, brushes: ov.brushes, validate: v }, null, 1));
await client.close();
