import { describe, expect, it } from 'vitest';
import path from 'path';

import {
  prioritizeLlamaBackendCandidates,
  resolveLlamaServerBackendCandidates,
  resolveLlamaRouterCapacity,
  selectPreferredWindowsGpuRow,
} from '../llama-server-manager';

describe('llama-server backend resolution', () => {
  const resourcesDir = path.join('/app', 'resources', 'llama-server');
  const gb = (value: number) => value * 1024 ** 3;

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

  it('uses a single router model when both total RAM and free RAM are low', () => {
    const decision = resolveLlamaRouterCapacity({
      backend: 'cuda-13.3',
      backendLabel: 'CUDA 13.3',
      totalRamBytes: gb(14),
      freeRamBytes: gb(4),
      gpuProbe: {
        source: 'test',
        gpuName: 'NVIDIA RTX',
        freeVramGB: 12,
        totalVramGB: 16,
        integratedGpu: false,
        reason: 'test',
      },
    });

    expect(decision.maxModels).toBe(1);
    expect(decision.allowEmbeddingPrewarm).toBe(false);
    expect(decision.reason).toContain('free RAM');
  });

  it('allows two router models when total RAM is at least 15GB even if free RAM is low', () => {
    const decision = resolveLlamaRouterCapacity({
      backend: 'darwin',
      backendLabel: 'macOS arm64',
      platform: 'darwin',
      totalRamBytes: gb(16),
      freeRamBytes: gb(1),
      gpuProbe: {
        source: 'test',
        gpuName: null,
        freeVramGB: null,
        totalVramGB: null,
        integratedGpu: true,
        reason: 'test',
      },
    });

    expect(decision.maxModels).toBe(2);
    expect(decision.allowEmbeddingPrewarm).toBe(false);
    expect(decision.reason).toContain('total RAM');
  });

  it('allows two router models for CUDA when free VRAM and RAM are sufficient', () => {
    const decision = resolveLlamaRouterCapacity({
      backend: 'cuda-13.3',
      backendLabel: 'CUDA 13.3',
      totalRamBytes: gb(32),
      freeRamBytes: gb(12),
      gpuProbe: {
        source: 'test',
        gpuName: 'NVIDIA RTX',
        freeVramGB: 8,
        totalVramGB: 12,
        integratedGpu: false,
        reason: 'test',
      },
    });

    expect(decision.maxModels).toBe(2);
    expect(decision.allowEmbeddingPrewarm).toBe(true);
  });

  it('uses one router model for CUDA when free VRAM is low', () => {
    const decision = resolveLlamaRouterCapacity({
      backend: 'cuda-12.4',
      backendLabel: 'CUDA 12.4',
      totalRamBytes: gb(32),
      freeRamBytes: gb(12),
      gpuProbe: {
        source: 'test',
        gpuName: 'NVIDIA RTX',
        freeVramGB: 4,
        totalVramGB: 8,
        integratedGpu: false,
        reason: 'test',
      },
    });

    expect(decision.maxModels).toBe(1);
    expect(decision.allowEmbeddingPrewarm).toBe(false);
  });

  it('keeps Windows Vulkan integrated GPUs conservative until total or free RAM is sufficient', () => {
    const low = resolveLlamaRouterCapacity({
      backend: 'vulkan',
      backendLabel: 'Vulkan',
      platform: 'win32',
      totalRamBytes: gb(14),
      freeRamBytes: gb(11),
      gpuProbe: {
        source: 'test',
        gpuName: 'AMD Radeon(TM) Vega 8 Graphics',
        freeVramGB: null,
        totalVramGB: 4,
        integratedGpu: true,
        reason: 'test',
      },
    });
    const high = resolveLlamaRouterCapacity({
      backend: 'vulkan',
      backendLabel: 'Vulkan',
      platform: 'win32',
      totalRamBytes: gb(24),
      freeRamBytes: gb(12),
      gpuProbe: {
        source: 'test',
        gpuName: 'AMD Radeon(TM) Vega 8 Graphics',
        freeVramGB: null,
        totalVramGB: 4,
        integratedGpu: true,
        reason: 'test',
      },
    });

    expect(low.maxModels).toBe(1);
    expect(low.allowEmbeddingPrewarm).toBe(false);
    expect(high.maxModels).toBe(2);
    expect(high.allowEmbeddingPrewarm).toBe(true);
  });

  it('prefers a discrete Windows GPU over an integrated GPU for Vulkan capacity probing', () => {
    const selected = selectPreferredWindowsGpuRow([
      {
        name: 'Intel(R) Iris(R) Xe Graphics',
        totalVramGB: 1,
        integratedGpu: true,
      },
      {
        name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
        totalVramGB: 8,
        integratedGpu: false,
      },
    ]);

    expect(selected?.name).toBe('NVIDIA GeForce RTX 4060 Laptop GPU');
    expect(selected?.integratedGpu).toBe(false);
  });

  it('always uses one router model for CPU backend', () => {
    const decision = resolveLlamaRouterCapacity({
      backend: 'cpu',
      backendLabel: 'CPU',
      totalRamBytes: gb(64),
      freeRamBytes: gb(48),
    });

    expect(decision.maxModels).toBe(1);
    expect(decision.allowEmbeddingPrewarm).toBe(false);
  });
});
