// Generated from contracts/native/commands.json. DO NOT EDIT.
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export function open_settings(invoke: Invoke): Promise<void> { return invoke<void>("open_settings"); }
export function daemon_health(invoke: Invoke): Promise<unknown> { return invoke<unknown>("daemon_health"); }
