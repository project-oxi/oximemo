import type { FolderSchema, SchemaPropertyDef, SchemaPropType } from "./types";

/** Rust's PropertyDef serializes its prop_type field as `type`. Keep the
 * UI's existing model at the IPC boundary without changing stored schemas. */
export type FolderSchemaWire = Omit<FolderSchema, "properties"> & {
  properties?: Record<string, SchemaPropertyDef & { type?: SchemaPropType }>;
};

export function normalizeFolderSchema(schema: FolderSchemaWire | null): FolderSchema | null {
  if (!schema?.properties) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, def]) => [
        key,
        { ...def, prop_type: def.type ?? def.prop_type },
      ]),
    ),
  };
}
