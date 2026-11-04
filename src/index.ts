#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { Brush, Entity, MapFile, Vec3 } from "./map/model.js";
import { classname, getProp, parseOrigin, removeProp, setProp } from "./map/model.js";
import { parseMap } from "./map/parser.js";
import { serializeMap } from "./map/writer.js";
import { boundsOfPoints, brushBounds, brushVertices, entityBounds, mapBounds, planeFromPoints } from "./map/geometry.js";
import { bevelSolid, boxSolid, brushFromSolid, inset, intersects, isValidSolid, planeThrough, prismSolid, rotateBrush, rotationMatrix, solidFromBrush, split, subtract, wedgeSolid, type Solid } from "./map/csg.js";
import { makeBoxBrush, shouldWriteValve, translateEntity, usesValveFormat } from "./map/builder.js";
import { renderView, type ViewName } from "./render/svg.js";
import { atomicWrite, ensureTbMcpDir, listBackups, restoreLatest, snapshot } from "./backup.js";
import { parseFgd, resolveClass } from "./fgd/parser.js";
import { compileMap } from "./compile.js";
import { launchMap } from "./launch.js";
import { compileShogoMap } from "./shogo.js";

// KEEP THIS IN STEP WITH package.json. It is what a client reports back as
// serverInfo, which makes it the only way to tell WHICH BUILD a running client
// is actually serving - and that matters more than it sounds: this repo has two
// independent outputs from the same source (`npm run build` -> dist/index.js,
// which clients are registered against, and `npm run bundle` ->
// dist/trenchbroom-mcp.mjs, which the Shogo kit ships). Rebuilding one and not
// the other left a client running five-day-old code while the source, the
// bundle and the tests all said the fix was in. `npm run dist` builds both.
const server = new McpServer({ name: "trenchbroom-mcp", version: "0.6.0" });

// Appended to every tool that WRITES the map file.
//
// TrenchBroom-HL watches the open .map (QFileSystemWatcher, 500ms debounce)
// and calls applyExternalChanges() before any hard reload, so an edit made
// out here shows up on its own with the selection and camera intact. These
// descriptions used to say "reload in TrenchBroom to see it", which has been
// wrong since that landed and had the mapping thread reloading by hand.
//
// The unsaved-edits case belongs in the DESCRIPTION rather than in this
// comment, because it presents as the tool silently failing: TrenchBroom
// raises a modal whose default button KEEPS the editor version, so the write
// reaches disk and is then discarded - and the dialog can sit behind the
// editor window while it happens.
const EDITOR_NOTE =
  " Writes the file; if the map is open in TrenchBroom, reload it there (the editor detects the change and asks - keep the editor version if you have unsaved edits, then merge by hand).";

// ---------- helpers ----------

function loadMap(mapPath: string): MapFile {
  const text = fs.readFileSync(mapPath, "utf8");
  return parseMap(text);
}

function saveMap(mapPath: string, map: MapFile): void {
  atomicWrite(mapPath, serializeMap(map));
}

/** Load, snapshot, mutate, save. Every mutating tool goes through here. */
function withMap<T extends object>(mapPath: string, fn: (map: MapFile) => T): T & { backup: string } {
  const map = loadMap(mapPath);
  const backup = snapshot(mapPath);
  const result = fn(map);
  saveMap(mapPath, map);
  return { ...result, backup };
}

function entityAt(map: MapFile, index: number): Entity {
  const e = map.entities[index];
  if (!e) throw new Error(`no entity at index ${index} (map has ${map.entities.length} entities)`);
  return e;
}

function entitySummary(e: Entity, index: number) {
  const bounds = entityBounds(e);
  return {
    index,
    classname: classname(e),
    targetname: getProp(e, "targetname"),
    origin: parseOrigin(e),
    brushes: e.brushes.length,
    bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
  };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

function tool<A extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: A,
  handler: (args: z.objectOutputType<A, z.ZodTypeAny>) => unknown
): void {
  const callback = async (args: any) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return toolError(err);
    }
  };
  server.registerTool(name, { description, inputSchema: schema }, callback as any);
}

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const mapPathSchema = z.string().describe("Absolute path to the .map file");

// ---------- read tools ----------

tool(
  "map_overview",
  "Summarize a .map file: entity/brush counts, bounds, format, TrenchBroom layers/groups, textures in use, and entity class histogram.",
  { map_path: mapPathSchema },
  ({ map_path }) => {
    const map = loadMap(map_path);
    const classCounts: Record<string, number> = {};
    const textures = new Set<string>();
    let brushCount = 0;
    const layers: string[] = [];
    const groups: string[] = [];
    for (const e of map.entities) {
      const cls = classname(e);
      classCounts[cls] = (classCounts[cls] ?? 0) + 1;
      brushCount += e.brushes.length;
      for (const b of e.brushes) for (const f of b.faces) textures.add(f.texture);
      const tbType = getProp(e, "_tb_type");
      if (tbType === "_tb_layer") layers.push(getProp(e, "_tb_name") ?? "(unnamed)");
      if (tbType === "_tb_group") groups.push(getProp(e, "_tb_name") ?? "(unnamed)");
    }
    const bounds = mapBounds(map);
    return {
      entities: map.entities.length,
      brushes: brushCount,
      format: usesValveFormat(map) ? "valve220" : "standard",
      bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
      classCounts,
      layers,
      groups,
      textures: [...textures].sort().slice(0, 50),
    };
  }
);

tool(
  "list_entities",
  "List entities with index, classname, targetname, origin, brush count, and bounds. Optionally filter by classname substring or a property key/value.",
  {
    map_path: mapPathSchema,
    classname_filter: z.string().optional().describe("Case-insensitive substring match on classname"),
    property_key: z.string().optional().describe("Only entities that have this property"),
    property_value: z.string().optional().describe("With property_key: require this exact value"),
  },
  ({ map_path, classname_filter, property_key, property_value }) => {
    const map = loadMap(map_path);
    const out = [];
    for (let i = 0; i < map.entities.length; i++) {
      const e = map.entities[i];
      if (classname_filter && !classname(e).toLowerCase().includes(classname_filter.toLowerCase())) continue;
      if (property_key) {
        const v = getProp(e, property_key);
        if (v === undefined) continue;
        if (property_value !== undefined && v !== property_value) continue;
      }
      out.push(entitySummary(e, i));
    }
    return { count: out.length, entities: out };
  }
);

tool(
  "get_entity",
  "Full detail for one entity: all properties, brush list with per-brush bounds and face count.",
  { map_path: mapPathSchema, index: z.number().int().describe("Entity index from list_entities") },
  ({ map_path, index }) => {
    const map = loadMap(map_path);
    const e = entityAt(map, index);
    return {
      ...entitySummary(e, index),
      properties: Object.fromEntries(e.properties.map((p) => [p.key, p.value])),
      brushList: e.brushes.map((b, bi) => {
        const bounds = entityBounds({ properties: [], brushes: [b] });
        return {
          index: bi,
          faces: b.faces.length,
          textures: [...new Set(b.faces.map((f) => f.texture))],
          bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
        };
      }),
    };
  }
);

// ---------- mutation tools ----------

tool(
  "add_entity",
  "Add a point entity (e.g. a light, monster, item)." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    classname: z.string().describe('Entity class, e.g. "light" or "info_player_start"'),
    origin: vec3Schema.optional().describe("Position [x y z]; omitted for non-positional entities"),
    properties: z.record(z.string()).optional().describe("Additional key/value properties"),
  },
  ({ map_path, classname: cls, origin, properties }) =>
    withMap(map_path, (map) => {
      const e: Entity = { properties: [{ key: "classname", value: cls }], brushes: [] };
      if (origin) setProp(e, "origin", origin.map(String).join(" "));
      for (const [k, v] of Object.entries(properties ?? {})) setProp(e, k, v);
      map.entities.push(e);
      return { added: entitySummary(e, map.entities.length - 1) };
    })
);

tool(
  "set_entity_properties",
  "Set and/or remove properties on an existing entity." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    index: z.number().int(),
    set: z.record(z.string()).optional().describe("Properties to set or overwrite"),
    remove: z.array(z.string()).optional().describe("Property keys to delete"),
  },
  ({ map_path, index, set, remove }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, index);
      for (const [k, v] of Object.entries(set ?? {})) setProp(e, k, v);
      const removed = (remove ?? []).filter((k) => removeProp(e, k));
      return { entity: entitySummary(e, index), removed };
    })
);

tool(
  "delete_entity",
  "Delete an entity (and all its brushes). Refuses to delete worldspawn." + EDITOR_NOTE,
  { map_path: mapPathSchema, index: z.number().int() },
  ({ map_path, index }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, index);
      if (classname(e) === "worldspawn") throw new Error("refusing to delete worldspawn");
      map.entities.splice(index, 1);
      return { deleted: { index, classname: classname(e) } };
    })
);

tool(
  "add_brush_box",
  "Add an axis-aligned box brush. Defaults to worldspawn (entity 0); pass entity_index to add to a brush entity like func_door. Matches the map's existing texture format; on an empty map inside a Shogo workspace it writes Standard, which is the only format that game's converter reads." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    min: vec3Schema.describe("Minimum corner [x y z]"),
    max: vec3Schema.describe("Maximum corner [x y z]"),
    texture: z.string().describe('Texture name, e.g. "__TB_empty" or a texture from map_overview'),
    entity_index: z.number().int().optional().describe("Owning entity index; default 0 (worldspawn)"),
  },
  ({ map_path, min, max, texture, entity_index }) =>
    withMap(map_path, (map) => {
      for (let i = 0; i < 3; i++) {
        if (min[i] >= max[i]) throw new Error(`min must be strictly less than max on every axis (axis ${i}: ${min[i]} >= ${max[i]})`);
      }
      const idx = entity_index ?? 0;
      const e = entityAt(map, idx);
      e.brushes.push(makeBoxBrush(min as Vec3, max as Vec3, texture, shouldWriteValve(map, map_path)));
      return { entity: idx, brushIndex: e.brushes.length - 1, min, max, texture };
    })
);

tool(
  "delete_brush",
  "Delete one brush from an entity." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    entity_index: z.number().int(),
    brush_index: z.number().int().describe("Brush index within the entity, from get_entity"),
  },
  ({ map_path, entity_index, brush_index }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      if (!e.brushes[brush_index]) throw new Error(`no brush at index ${brush_index} (entity has ${e.brushes.length})`);
      e.brushes.splice(brush_index, 1);
      return { deleted: { entity: entity_index, brush: brush_index } };
    })
);

tool(
  "translate_entity",
  "Move an entity by a delta: shifts all brush geometry (keeping textures locked in Valve format) and/or the origin property." + EDITOR_NOTE,
  { map_path: mapPathSchema, index: z.number().int(), delta: vec3Schema.describe("Offset [dx dy dz]") },
  ({ map_path, index, delta }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, index);
      translateEntity(e, delta as Vec3);
      return { entity: entitySummary(e, index) };
    })
);

// ---------- undo / backups ----------

tool(
  "undo_last_edit",
  "Restore the map to its state before the most recent edit made by this server (snapshot-based; one step per call)." + EDITOR_NOTE,
  { map_path: mapPathSchema },
  ({ map_path }) => {
    const restored = restoreLatest(map_path);
    if (!restored) throw new Error("no backups available for this map");
    return { restoredFrom: restored, remainingBackups: listBackups(map_path).length };
  }
);

tool(
  "list_backups",
  "List snapshot backups (made automatically before every edit) for a map.",
  { map_path: mapPathSchema },
  ({ map_path }) => ({ backups: listBackups(map_path) })
);

// ---------- rendering ----------

tool(
  "render_preview",
  "Render a 2D orthographic preview of the map as an SVG file: brush footprints (worldspawn gray, brush entities orange) and point entities (blue dots with labels). Views: top (X/Y), front (X/Z), side (Y/Z).",
  {
    map_path: mapPathSchema,
    view: z.enum(["top", "front", "side"]).optional().describe("Default: top"),
    out_path: z.string().optional().describe("Where to write the SVG; default <mapdir>/.tb-mcp/preview-<view>.svg"),
  },
  ({ map_path, view, out_path }) => {
    const map = loadMap(map_path);
    const v: ViewName = view ?? "top";
    const result = renderView(map, v);
    const dest =
      out_path ?? path.join(ensureTbMcpDir(map_path), `preview-${v}.svg`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, result.svg);
    return {
      svgPath: dest,
      view: v,
      brushesDrawn: result.brushCount,
      pointEntitiesDrawn: result.pointEntityCount,
    };
  }
);

// ---------- Compile ----------

tool(
  "compile_map",
  "Compile a .map with ericw-tools and report what the compiler said. Runs qbsp by " +
    "default; pass stages for a full build. Detects leaks, which the compiler reports " +
    "as a warning and still exits successfully, and returns the coordinate the leak " +
    "escaped from.",
  {
    map_path: z.string().describe("Absolute path to the .map file"),
    stages: z
      .array(z.enum(["qbsp", "vis", "light"]))
      .optional()
      .describe('Which tools to run, in order. Default ["qbsp"]. vis is slow.'),
    tools_dir: z
      .string()
      .optional()
      .describe("Directory holding qbsp/vis/light. Defaults to $ERICW_TOOLS_DIR, then PATH."),
    qbsp_args: z.array(z.string()).optional().describe('Extra qbsp arguments, e.g. ["-nopercent"]'),
    vis_args: z.array(z.string()).optional().describe("Extra vis arguments"),
    light_args: z.array(z.string()).optional().describe('Extra light arguments, e.g. ["-extra4"]'),
    timeout_seconds: z.number().optional().describe("Per-tool timeout. Default 600."),
    keep_logs: z
      .boolean()
      .optional()
      .describe("Leave the .log files the tools write beside the map. Off by default."),
  },
  ({ map_path, stages, tools_dir, qbsp_args, vis_args, light_args, timeout_seconds, keep_logs }) =>
    compileMap({
      mapPath: map_path,
      stages,
      toolsDir: tools_dir,
      extraArgs: { qbsp: qbsp_args, vis: vis_args, light: light_args },
      timeoutSeconds: timeout_seconds,
      keepLogs: keep_logs,
    })
);

tool(
  "compile_shogo_map",
  "Compile a .map for Shogo: Mobile Armor Division and report what the compiler produced. " +
    "This is a DIFFERENT toolchain from compile_map - Shogo uses the SDK's Processor.exe " +
    "(.map -> .ed -> .dat), not ericw-tools, and the two are not interchangeable. Drives " +
    "the Shogo mapping kit, so it inherits the compiler's documented traps rather than " +
    "repeating them. Reports light map nodes, which is the number that says whether the " +
    "world is lit or will render black.",
  {
    map_path: z.string().describe("Absolute path to the .map file"),
    kit_dir: z
      .string()
      .optional()
      .describe("The ShogoMapping folder (holds tools/). Defaults to $SHOGO_KIT_DIR."),
    workspace: z
      .string()
      .optional()
      .describe(
        "Folder holding shogo-mapping.json, written by the kit's setup.ps1. " +
          "Defaults to $SHOGO_WORKSPACE."
      ),
    lighting: z
      .boolean()
      .optional()
      .describe("Run the lighting stage. On by default; off is faster while blocking out."),
    install: z
      .boolean()
      .optional()
      .describe("Copy the compiled .dat into the game's Custom folder. On by default."),
    install_target: z
      .enum(["mp", "sp"])
      .optional()
      .describe(
        'Where under Custom to install. "mp" is Custom\\maps\\mp, which the multiplayer ' +
          'host and rotation lists scan; "sp" is Custom itself, which the single-player ' +
          "custom menu scans. Left out, it follows the map's own GameStartPoint GameType, " +
          "so a deathmatch map lands where the host list will find it."
      ),
    timeout_seconds: z.number().optional().describe("Per-step timeout. Default 600."),
  },
  ({ map_path, kit_dir, workspace, lighting, install, install_target, timeout_seconds }) =>
    compileShogoMap({
      mapPath: map_path,
      kitDir: kit_dir,
      workspace,
      lighting,
      install,
      installTarget: install_target,
      timeoutSeconds: timeout_seconds,
    })
);

tool(
  "launch_map",
  "Launch a compiled map in a Quake engine. Copies the .bsp into the game's maps " +
    "directory, starts the engine on that map, and reports anything the engine said " +
    "if it refused to start. Compile the map first: the engine loads the .bsp, not " +
    "the .map.",
  {
    bsp_path: z
      .string()
      .describe("Absolute path to the compiled .bsp (a .map path is accepted and swapped)"),
    engine_path: z.string().describe("Absolute path to the engine, e.g. quakespasm.exe"),
    game_dir: z
      .string()
      .optional()
      .describe("Directory containing id1. Defaults to the engine's own directory."),
    mod: z.string().optional().describe('Mod directory, e.g. "ad" or "copper". Defaults to id1.'),
    extra_args: z.array(z.string()).optional().describe('Extra engine arguments, e.g. ["-fitz"]'),
    install_bsp: z
      .boolean()
      .optional()
      .describe("Copy the .bsp into the maps directory first. On by default."),
    condebug: z
      .boolean()
      .optional()
      .describe(
        "Ask the engine to write qconsole.log so failures are visible. On by default; " +
          "writes that file into the game directory."
      ),
    grace_seconds: z
      .number()
      .optional()
      .describe("How long to watch for the engine dying before calling it launched. Default 3."),
  },
  ({ bsp_path, engine_path, game_dir, mod, extra_args, install_bsp, condebug, grace_seconds }) =>
    launchMap({
      bspPath: bsp_path,
      enginePath: engine_path,
      gameDir: game_dir,
      mod,
      extraArgs: extra_args,
      installBsp: install_bsp,
      condebug,
      graceMs: grace_seconds === undefined ? undefined : grace_seconds * 1000,
    })
);

// ---------- FGD ----------

tool(
  "fgd_classes",
  "List entity classes defined in an FGD file (name, type, description). Use this to learn what entities a game supports.",
  {
    fgd_path: z.string().describe("Absolute path to the .fgd file"),
    filter: z.string().optional().describe("Case-insensitive substring filter on class name"),
  },
  ({ fgd_path, filter }) => {
    const classes = parseFgd(fs.readFileSync(fgd_path, "utf8"));
    const out = classes
      .filter((c) => c.type !== "BaseClass")
      .filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
      .map((c) => ({ name: c.name, type: c.type, description: c.description }));
    return { count: out.length, classes: out };
  }
);

tool(
  "fgd_class",
  "Full definition of one FGD entity class with inherited properties and spawnflags resolved from its base classes.",
  {
    fgd_path: z.string().describe("Absolute path to the .fgd file"),
    classname: z.string(),
  },
  ({ fgd_path, classname: cls }) => {
    const classes = parseFgd(fs.readFileSync(fgd_path, "utf8"));
    const resolved = resolveClass(classes, cls);
    if (!resolved) throw new Error(`class "${cls}" not found in ${fgd_path}`);
    return resolved;
  }
);

// ---------- brush / CSG tools ----------

const snapSchema = z.boolean().optional().describe("Round plane points to whole units (TrenchBroom prefers integer planes). Default false.");
const entSchema = z.number().int().optional().describe("Owning entity index; default 0 (worldspawn)");

function pushSolid(map: MapFile, mapPath: string, e: Entity, solid: Solid, texture: string, snap?: boolean): number {
  if (!isValidSolid(solid)) throw new Error("resulting brush is degenerate (zero volume)");
  e.brushes.push(brushFromSolid(solid, texture, shouldWriteValve(map, mapPath), snap));
  return e.brushes.length - 1;
}

function brushAt(e: Entity, i: number) {
  const b = e.brushes[i];
  if (!b) throw new Error(`no brush at index ${i} (entity has ${e.brushes.length})`);
  return b;
}

tool(
  "add_brush_wedge",
  "Add a ramp/wedge brush filling the box min..max whose top slopes up toward `high` (+x, -x, +y or -y); the tall side keeps full height." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    min: vec3Schema, max: vec3Schema,
    high: z.enum(["+x", "-x", "+y", "-y"]).describe("Direction the ramp rises toward"),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, min, max, high, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const s = wedgeSolid(min as Vec3, max as Vec3, high, texture, shouldWriteValve(map, map_path));
      return { entity: entity_index ?? 0, brushIndex: pushSolid(map, map_path, e, s, texture, snap) };
    })
);

tool(
  "add_brush_prism",
  "Add a convex prism: a 2D polygon (xy points, hull taken) extruded between z_min and z_max. Use for arbitrary-angle walls, chamfered pillars, octagonal rooms." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
    z_min: z.number(), z_max: z.number(),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, polygon, z_min, z_max, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      if (z_min >= z_max) throw new Error("z_min must be below z_max");
      const e = entityAt(map, entity_index ?? 0);
      const s = prismSolid(polygon as [number, number][], z_min, z_max, texture, shouldWriteValve(map, map_path));
      return { entity: entity_index ?? 0, brushIndex: pushSolid(map, map_path, e, s, texture, snap) };
    })
);

tool(
  "add_brush_cylinder",
  "Add an n-sided cylinder (regular prism) around center [x y], from z_min to z_max. radius is to the corners." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    center: z.tuple([z.number(), z.number()]), radius: z.number().positive(),
    z_min: z.number(), z_max: z.number(),
    sides: z.number().int().min(3).max(64).optional().describe("Default 8"),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, center, radius, z_min, z_max, sides, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const n = sides ?? 8;
      const poly: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        poly.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
      }
      const e = entityAt(map, entity_index ?? 0);
      const s = prismSolid(poly, z_min, z_max, texture, shouldWriteValve(map, map_path));
      return { entity: entity_index ?? 0, brushIndex: pushSolid(map, map_path, e, s, texture, snap) };
    })
);

tool(
  "rotate_brush",
  "Rotate brushes about an axis through a pivot. Valve-format texture alignment stays locked to the geometry. Rotating a whole entity: omit brush_index." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(),
    brush_index: z.number().int().optional().describe("Omit to rotate every brush of the entity"),
    axis: z.enum(["x", "y", "z"]), degrees: z.number(),
    pivot: vec3Schema.optional().describe("Default: centre of the selection's bounds"),
  },
  ({ map_path, entity_index, brush_index, axis, degrees, pivot }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const targets = brush_index === undefined ? e.brushes : [brushAt(e, brush_index)];
      let p = pivot as Vec3 | undefined;
      if (!p) {
        const pts = targets.flatMap((b) => brushVertices(b));
        const bb = boundsOfPoints(pts);
        if (!bb) throw new Error("nothing to rotate");
        p = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      }
      const m = rotationMatrix(axis, degrees);
      for (const b of targets) rotateBrush(b, m, p);
      return { rotated: targets.length, pivot: p };
    })
);

tool(
  "clip_brush",
  "Cut a brush with a plane (point + outward normal of the side kept 'back' = opposite the normal). keep: 'back' trims it, 'front' keeps the other side, 'both' splits into two brushes. The cut face gets cut_texture." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int(),
    point: vec3Schema, normal: vec3Schema,
    keep: z.enum(["back", "front", "both"]),
    cut_texture: z.string(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, point, normal, keep, cut_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const valve = shouldWriteValve(map, map_path);
      const s = solidFromBrush(brushAt(e, brush_index));
      const { back, front } = split(s, planeThrough(normal as Vec3, point as Vec3));
      const keepers = [keep !== "front" ? back : null, keep !== "back" ? front : null].filter((x): x is Solid => !!x);
      if (keepers.length === 0) throw new Error("clip plane removes the whole brush; use delete_brush instead");
      e.brushes.splice(brush_index, 1, ...keepers.map((k) => brushFromSolid(k, cut_texture, valve, snap)));
      return { brushes: keepers.length };
    })
);

tool(
  "subtract_box",
  "Boolean subtract: carve the box min..max out of brushes (all brushes of the entity, or one). Each affected convex brush becomes up to 6 pieces, so doorways, windows and rooms can be cut from solid masses. New faces get cut_texture unless the cutter's texture is wanted." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: entSchema,
    brush_index: z.number().int().optional().describe("Only carve this brush; default every brush in the entity"),
    min: vec3Schema, max: vec3Schema, cut_texture: z.string(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, min, max, cut_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const valve = shouldWriteValve(map, map_path);
      const cutter = boxSolid(min as Vec3, max as Vec3, cut_texture, valve);
      const out: Brush[] = [];
      let carved = 0;
      e.brushes.forEach((b, i) => {
        if ((brush_index !== undefined && i !== brush_index) || !intersects(solidFromBrush(b), cutter)) {
          out.push(b);
          return;
        }
        carved++;
        for (const piece of subtract(solidFromBrush(b), cutter)) out.push(brushFromSolid(piece, cut_texture, valve, snap));
      });
      e.brushes = out;
      return { carved, brushesNow: out.length };
    })
);

tool(
  "hollow_brush",
  "Hollow an axis-aligned box brush into a room: replaces it with walls of the given thickness around an empty interior (up to 6 brushes)." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int(),
    wall: z.number().positive(), inner_texture: z.string().optional(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, wall, inner_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const b = brushAt(e, brush_index);
      const bb = brushBounds(b)!;
      const inn = inset(bb.min, bb.max, wall);
      for (let i = 0; i < 3; i++) if (inn.min[i] >= inn.max[i]) throw new Error("wall too thick for this brush");
      const valve = shouldWriteValve(map, map_path);
      const tex = inner_texture ?? b.faces[0].texture;
      const pieces = subtract(solidFromBrush(b), boxSolid(inn.min, inn.max, tex, valve));
      e.brushes.splice(brush_index, 1, ...pieces.map((p) => brushFromSolid(p, tex, valve, snap)));
      return { walls: pieces.length };
    })
);

tool(
  "bevel_brush",
  "Chamfer every edge of a brush by `size` units (cut faces get bevel_texture, default the brush's first face texture). For trims, lips and anything that must not read as a bare cube." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int(),
    size: z.number().positive(), bevel_texture: z.string().optional(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, size, bevel_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const b = brushAt(e, brush_index);
      const tex = bevel_texture ?? b.faces[0].texture;
      const valve = shouldWriteValve(map, map_path);
      const out = bevelSolid(solidFromBrush(b), size, tex, valve);
      if (!isValidSolid(out)) throw new Error("bevel too large for this brush");
      e.brushes[brush_index] = brushFromSolid(out, tex, valve, snap);
      return { faces: e.brushes[brush_index].faces.length };
    })
);

tool(
  "list_brushes",
  "List an entity's brushes with bounds, face count and textures, so brush_index values can be found without dumping the map.",
  { map_path: mapPathSchema, entity_index: entSchema },
  ({ map_path, entity_index }) => {
    const map = loadMap(map_path);
    const e = entityAt(map, entity_index ?? 0);
    return e.brushes.map((b, i) => {
      const bb = brushBounds(b);
      return { index: i, faces: b.faces.length, min: bb?.min, max: bb?.max, textures: [...new Set(b.faces.map((f) => f.texture))] };
    });
  }
);

tool(
  "set_face_texture",
  "Set texture, scale, rotation or offset on faces of a brush. Select faces by index, by outward direction ('+z' top, '-z' bottom, '+x', ...) or all. In Valve format, offset is [u, v]; scale applies to both axes unless two numbers are given." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int().optional().describe("Omit for every brush of the entity"),
    faces: z.union([z.literal("all"), z.enum(["+x", "-x", "+y", "-y", "+z", "-z"]), z.array(z.number().int())]).optional().describe("Default all"),
    texture: z.string().optional(),
    scale: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
    rotation: z.number().optional(),
    offset: z.tuple([z.number(), z.number()]).optional(),
  },
  ({ map_path, entity_index, brush_index, faces, texture, scale, rotation, offset }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const brushes = brush_index === undefined ? e.brushes : [brushAt(e, brush_index)];
      let changed = 0;
      for (const b of brushes) {
        b.faces.forEach((f, i) => {
          const n = planeFromPoints(...f.points).normal;
          const sel = faces ?? "all";
          let hit = false;
          if (sel === "all") hit = true;
          else if (Array.isArray(sel)) hit = sel.includes(i);
          else {
            const ax = sel[1] === "x" ? 0 : sel[1] === "y" ? 1 : 2;
            const sgn = sel[0] === "+" ? 1 : -1;
            hit = n[ax] * sgn > 0.7;
          }
          if (!hit) return;
          if (texture !== undefined) f.texture = texture;
          if (scale !== undefined) {
            const [sx, sy] = typeof scale === "number" ? [scale, scale] : scale;
            f.xScale = sx;
            f.yScale = sy;
          }
          if (rotation !== undefined) f.rotation = rotation;
          if (offset !== undefined) {
            if (f.uAxis && f.vAxis) {
              f.uAxis.offset = offset[0];
              f.vAxis.offset = offset[1];
            } else {
              f.xOffset = offset[0];
              f.yOffset = offset[1];
            }
          }
          f.raw = undefined;
          changed++;
        });
      }
      return { facesChanged: changed };
    })
);

// ---------- start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("trenchbroom-mcp ready");
