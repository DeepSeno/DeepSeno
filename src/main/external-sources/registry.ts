import type { ExternalSourceProvider } from './types';
import { FeishuCliProvider } from '../feishu-cli/provider';

const providers = new Map<string, ExternalSourceProvider>();

export function registerExternalSourceProvider(provider: ExternalSourceProvider): void {
  providers.set(provider.id, provider);
}

export function getExternalSourceProvider(source: string): ExternalSourceProvider {
  const provider = providers.get(source);
  if (!provider) {
    throw new Error(`External source provider not registered: ${source}`);
  }
  return provider;
}

export function listExternalSourceProviders(): ExternalSourceProvider[] {
  return Array.from(providers.values());
}

registerExternalSourceProvider(new FeishuCliProvider());
