import type { AppApi } from '../../hooks/useApi';

export async function openDirectoryPath(
  api: Pick<AppApi, 'openPath'>,
  dirPath: string | null | undefined,
): Promise<void> {
  const safePath = dirPath?.trim();
  if (!safePath) return;
  await api.openPath(safePath);
}
