// Keep existing imports typed against the Korean catalog key set.
import strings from "../../../locales/en.json";
import type { dict as ko } from "./ko";

export const dict: Record<keyof typeof ko, string> = strings;
