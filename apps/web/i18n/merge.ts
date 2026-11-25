export type MessageTree = {
  [key: string]: string | MessageTree;
};

export function isMessageTree(value: unknown): value is MessageTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Target values win. Missing target keys keep the English value.
 * `onMissing` is called for each English string the target does not define.
 */
export function deepMergeMessages(
  base: MessageTree,
  override: MessageTree,
  onMissing?: (path: string) => void,
  prefix = "",
): MessageTree {
  const result: MessageTree = { ...base };

  for (const [key, baseValue] of Object.entries(base)) {
    if (key in override) continue;
    const path = joinPath(prefix, key);
    if (typeof baseValue === "string") {
      onMissing?.(path);
    } else if (isMessageTree(baseValue)) {
      result[key] = deepMergeMessages(baseValue, {}, onMissing, path);
    }
  }

  for (const [key, overrideValue] of Object.entries(override)) {
    const path = joinPath(prefix, key);
    const baseValue = base[key];
    if (isMessageTree(baseValue) && isMessageTree(overrideValue)) {
      result[key] = deepMergeMessages(baseValue, overrideValue, onMissing, path);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

export function lookupMessage(
  tree: MessageTree,
  path: string,
): string | undefined {
  let current: string | MessageTree | undefined = tree;
  for (const part of path.split(".")) {
    if (!part || !isMessageTree(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}
