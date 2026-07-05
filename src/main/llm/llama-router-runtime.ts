import fs from 'fs';
import path from 'path';
import { getLLMModelsDir } from '../paths';

function resolveBundledModelsPreset(): string | null {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'llama-models', 'models.ini') : '',
    path.join(__dirname, '..', '..', 'resources', 'llama-models', 'models.ini'),
    path.join(process.cwd(), 'resources', 'llama-models', 'models.ini'),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function prepareLlamaRouterRuntime(): { modelsDir: string; presetPath?: string } {
  const modelsDir = getLLMModelsDir();
  fs.mkdirSync(modelsDir, { recursive: true });

  const presetDest = path.join(modelsDir, 'models.ini');
  const presetSrc = resolveBundledModelsPreset();
  try {
    if (presetSrc) {
      const shouldCopy =
        !fs.existsSync(presetDest) ||
        fs.statSync(presetSrc).mtimeMs > fs.statSync(presetDest).mtimeMs;
      if (shouldCopy) {
        fs.copyFileSync(presetSrc, presetDest);
      }
    }
  } catch (err) {
    console.warn('[LlamaServer] Failed to prepare models preset:', err);
  }

  return {
    modelsDir,
    presetPath: fs.existsSync(presetDest) ? presetDest : undefined,
  };
}
