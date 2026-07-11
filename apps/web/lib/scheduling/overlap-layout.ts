/**
 * Column layout for concurrent calendar blocks. Appointments that overlap in
 * time get split side by side instead of stacking on top of each other:
 * items are grouped into clusters (connected chains of overlap), each item
 * takes the first column that is free at its start time, and every item in a
 * cluster shares the cluster's column count so widths line up.
 */

export type OverlapInput = {
  id: string;
  startMs: number;
  endMs: number;
};

export type OverlapPosition = {
  /** 0-based column inside the cluster. */
  column: number;
  /** Total columns in the cluster (divide the width by this). */
  columns: number;
};

export function layoutOverlaps(
  items: OverlapInput[]
): Map<string, OverlapPosition> {
  const result = new Map<string, OverlapPosition>();

  const sorted = [...items]
    .map((item) => ({
      ...item,
      // Zero/negative durations still occupy a sliver so they cluster.
      endMs: Math.max(item.endMs, item.startMs + 1),
    }))
    .sort(
      (a, b) =>
        a.startMs - b.startMs || b.endMs - a.endMs || a.id.localeCompare(b.id)
    );

  let cluster: { id: string; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    for (const member of cluster) {
      result.set(member.id, {
        column: member.column,
        columns: columnEnds.length,
      });
    }
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (cluster.length > 0 && item.startMs >= clusterEnd) {
      closeCluster();
    }

    let column = columnEnds.findIndex((end) => end <= item.startMs);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.endMs);
    } else {
      columnEnds[column] = item.endMs;
    }

    cluster.push({ id: item.id, column });
    clusterEnd = Math.max(clusterEnd, item.endMs);
  }
  closeCluster();

  return result;
}
