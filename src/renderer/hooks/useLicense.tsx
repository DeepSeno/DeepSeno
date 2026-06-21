import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useApi, LicenseStatus } from './useApi';

interface LicenseContextValue {
  status: LicenseStatus | null;
  isPro: boolean;
  tier: string;
  features: string[];
  isFeatureAvailable: (feature: string) => boolean;
  refresh: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue>({
  status: null,
  isPro: true,
  tier: 'trial',
  features: [],
  isFeatureAvailable: () => true,
  refresh: async () => {},
});

export function LicenseProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [status, setStatus] = useState<LicenseStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.licenseGetStatus();
      setStatus(s);
    } catch {
      // fallback: assume trial
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const unsub = api.onLicenseChanged?.(() => refresh());
    return unsub;
  }, [api, refresh]);

  const isPro = status ? (status.licensed || status.trial.active) : true;
  const tier = status?.tier || 'trial';
  const features = status?.features || [];
  const isFeatureAvailable = useCallback(
    (f: string) => features.includes(f),
    [features],
  );

  return (
    <LicenseContext.Provider value={{ status, isPro, tier, features, isFeatureAvailable, refresh }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense() {
  return useContext(LicenseContext);
}
