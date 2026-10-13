import { describe, expect, test } from "bun:test";
import { normalizeFolderSchema, type FolderSchemaWire } from "./folderSchema";

describe("folder schema IPC", () => {
  test("Rust's serialized types select the right property editors", () => {
    const schema: FolderSchemaWire = {
      meta: { preset: "knowledge" },
      properties: {
        source: { type: "text" },
        status: { type: "select", options: ["stub", "understood"], required: true, colors: { stub: "neutral" } },
        aliases: { type: "multiselect", options: ["AI", "SW"] },
        reviewed: { type: "date" },
        published: { type: "bool" },
      },
    };
    const normalized = normalizeFolderSchema(schema)!;
    expect(Object.values(normalized.properties!).map((def) => def.prop_type)).toEqual([
      "text", "select", "multiselect", "date", "bool",
    ]);
    expect(normalized.properties!.status.options).toBe(schema.properties!.status.options);
    expect(normalized.properties!.status.colors).toBe(schema.properties!.status.colors);
    expect(normalized.properties!.status.required).toBe(true);
    expect(normalized.meta).toBe(schema.meta);
    expect(schema.properties!.status.prop_type).toBeUndefined();
  });

  test("browser fixtures with prop_type remain supported", () => {
    expect(normalizeFolderSchema({ properties: { status: { prop_type: "select" } } })?.properties?.status.prop_type).toBe("select");
    expect(normalizeFolderSchema({ properties: { status: { type: "date", prop_type: "text" } } })?.properties?.status.prop_type).toBe("date");
  });

  test("free properties retain the absence of a schema", () => {
    expect(normalizeFolderSchema(null)).toBeNull();
    const empty = { workspace: { name: "Inbox" } };
    expect(normalizeFolderSchema(empty)).toBe(empty);
    expect(normalizeFolderSchema({ properties: {} })).toEqual({ properties: {} });
  });
});
