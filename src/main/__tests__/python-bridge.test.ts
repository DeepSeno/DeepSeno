import { describe, it, expect } from 'vitest';
import { PythonBridge } from '../python-bridge';
import path from 'path';

describe('PythonBridge', () => {
  const bridge = new PythonBridge(path.join(__dirname, '../../../python'));

  it('should instantiate', () => {
    expect(bridge).toBeDefined();
  });

  it('isVenvReady should return boolean', () => {
    const ready = bridge.isVenvReady();
    expect(typeof ready).toBe('boolean');
  });

  it('should reject on nonexistent script', async () => {
    await expect(bridge.run('nonexistent_script_xyz.py')).rejects.toThrow();
  });
});
