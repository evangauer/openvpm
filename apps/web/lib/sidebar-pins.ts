import { TOOL_PATHS } from "./navigation";

export type SidebarLayout = "full" | "focused";
export type SidebarPreferences = {
  layout: SidebarLayout;
  pinned: string[];
};

export function sidebarPinsKey(practiceId: string, userId: string) {
  return `openvpm.sidebar.v1.${practiceId}.${userId}`;
}

export function parseSidebarPreferences(
  raw: string | null,
): SidebarPreferences {
  const fallback: SidebarPreferences = { layout: "full", pinned: [] };
  if (!raw || raw.length > 4096) return fallback;
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
      return fallback;
    // The initial pinning preview had only a focused layout. Preserve that
    // explicit preview preference while leaving untouched accounts on full nav.
    const layout = !("layout" in value)
      ? "focused"
      : value.layout === "focused"
        ? "focused"
        : "full";
    return {
      layout,
      pinned: [
        ...new Set(
          value.pinned.filter(
            (item): item is string =>
              typeof item === "string" && TOOL_PATHS.includes(item),
          ),
        ),
      ],
    };
  } catch {
    return fallback;
  }
}

export function parseSidebarPins(raw: string | null): string[] {
  return parseSidebarPreferences(raw).pinned;
}

export function serializeSidebarPreferences(preferences: SidebarPreferences) {
  return JSON.stringify({
    ...JSON.parse(serializeSidebarPins(preferences.pinned)),
    layout: preferences.layout === "focused" ? "focused" : "full",
  });
}

export function serializeSidebarPins(pinned: string[]) {
  return JSON.stringify({
    version: 1,
    pinned: [...new Set(pinned.filter((href) => TOOL_PATHS.includes(href)))],
  });
}
