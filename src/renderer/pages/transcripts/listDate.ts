type ListTimestampSource = {
  recorded_at?: string | null;
  processed_at?: string | null;
  status_updated_at?: string | null;
};

export type LibraryListDateGroup = 'today' | 'yesterday' | 'earlier';

export interface LibraryListDateMeta {
  dateGroup: LibraryListDateGroup;
  actualDate: string;
  time: string;
}

function isValidDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function getLibraryListTimestamp(source: ListTimestampSource): string | null {
  return source.processed_at || source.status_updated_at || source.recorded_at || null;
}

export function getLibraryListDateMeta(
  source: ListTimestampSource,
  locale: string,
  now: Date = new Date(),
): LibraryListDateMeta {
  const timestamp = getLibraryListTimestamp(source);
  const parsed = timestamp ? new Date(timestamp) : new Date(now);
  const date = isValidDate(parsed) ? parsed : new Date(now);
  const localDay = startOfLocalDay(date);
  const today = startOfLocalDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  let dateGroup: LibraryListDateGroup = 'earlier';
  if (localDay.getTime() >= today.getTime()) dateGroup = 'today';
  else if (localDay.getTime() >= yesterday.getTime()) dateGroup = 'yesterday';

  return {
    dateGroup,
    actualDate: toLocalDateKey(localDay),
    time: timestamp && isValidDate(parsed)
      ? parsed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : '',
  };
}
