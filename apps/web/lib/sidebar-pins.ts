import { TOOL_PATHS } from "./navigation";

export function sidebarPinsKey(practiceId: string, userId: string) {
  return `openvpm.sidebar.v1.${practiceId}.${userId}`;
}

export function parseSidebarPins(raw: string | null): string[] {
  if (!raw || raw.length > 4096) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("pinned" in value) ||
      !Array.isArray(value.pinned)
    )
      return [];
    return [
      ...new Set(
        value.pinned.filter(
          (item): item is string =>
            typeof item === "string" && TOOL_PATHS.includes(item),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

export function serializeSidebarPins(pinned: string[]) {
  return JSON.stringify({
    version: 1,
    pinned: [...new Set(pinned.filter((href) => TOOL_PATHS.includes(href)))],
  });
}
