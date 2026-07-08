import { describe, expect, it } from 'vitest';
import path from 'path';

import {
  prioritizeLlamaBackendCandidates,
  resolveLlamaServerBackendCandidates,
} from '../llama-server-manager';

describe('llama-server backend resolution', () => {
  const resourcesDir = path.join('/app', 'resources', 'llama-server');

  function existsFrom(files: string[]) {
    const normalized = new Set(files.map((file) => path.normalize(file)));
    return (filePath: string) => normalized.has(path.normalize(filePath));
  }

  it('orders Windows NVIDIA backends by CUDA, Vulkan, then CPU', () => {
    const root = path.join(resourcesDir, 'win32-x64');
    const candidates = resolveLlamaServerBackendCandidates({
      platform: 'win32',
      arch: 'x64',
      resourcesDir,
      hasNvidiaGpu: true,
      env: { PATH: 'C:\\Windows\\System32' },
      pathDelimiter: ';',
      exists: existsFrom([
        path.join(root, 'cuda-13.3', 'llama-server.exe'),
        path.join(root, 'cuda-12.4', 'llama-server.exe'),
        path.join(root, 'vulkan', 'llama-server.exe'),
        path.join(root, 'cpu', 'llama-server.exe'),
      ]),
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'cuda-13.3',
      'cuda-12.4',
      'vulkan',
      'cpu',
    ]);
    expect(candidates[0].env.PATH?.startsWith(path.join(root, 'cuda-13.3'))).toBe(true);
  });

  it('skips CUDA on Windows when no NVIDIA GPU is detected', () => {
    const root = path.join(resourcesDir, 'win32-x64');
    const candidates = resolveLlamaServerBackendCandidates({
      platform: 'win32',
      arch: 'x64',
      resourcesDir,
      hasNvidiaGpu: false,
      exists: existsFrom([
        path.join(root, 'cuda-13.3', 'llama-server.exe'),
        path.join(root, 'vulkan', 'llama-server.exe'),
        path.join(root, 'cpu', 'llama-server.exe'),
      ]),
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['vulkan', 'cpu']);
  });

  it('keeps legacy mixed-directory Windows bundles as fallback-compatible', () => {
    const root = path.join(resourcesDir, 'win32-x64');
    const candidates = resolveLlamaServerBackendCandidates({
      platform: 'win32',
      arch: 'x64',
      resourcesDir,
      hasNvidiaGpu: true,
      exists: existsFrom([
        path.join(root, 'llama-server-cuda.exe'),
        path.join(root, 'llama-server-vulkan.exe'),
        path.join(root, 'llama-server-cpu.exe'),
      ]),
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['cuda', 'vulkan', 'cpu']);
    expect(candidates.map((candidate) => path.basename(candidate.binaryPath))).toEqual([
      'llama-server-cuda.exe',
      'llama-server-vulkan.exe',
      'llama-server-cpu.exe',
    ]);
  });

  it('prioritizes the cached working backend when it is available', () => {
    const candidates = [
      { id: 'cuda-13.3', label: 'CUDA 13.3' },
      { id: 'vulkan', label: 'Vulkan' },
      { id: 'cpu', label: 'CPU' },
    ].map((candidate) => ({
      ...candidate,
      binaryPath: `/bin/${candidate.id}/llama-server.exe`,
      workDir: `/bin/${candidate.id}`,
      env: {},
    }));

    expect(prioritizeLlamaBackendCandidates(candidates, 'cpu').map((candidate) => candidate.id)).toEqual([
      'cpu',
      'cuda-13.3',
      'vulkan',
    ]);
    expect(prioritizeLlamaBackendCandidates(candidates, 'missing')).toBe(candidates);
  });
});
