export interface VirtualRange {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function getVirtualRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): VirtualRange {
  if (count <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  }

  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewport = Math.max(0, viewportHeight);
  const visibleStart = Math.floor(safeScrollTop / rowHeight);
  const visibleEnd = Math.ceil((safeScrollTop + safeViewport) / rowHeight);
  const end = Math.min(count, visibleEnd + overscan);
  const start = Math.min(Math.max(0, visibleStart - overscan), end);

  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight: count * rowHeight,
  };
}
