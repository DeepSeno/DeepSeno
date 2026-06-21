import { ReactNode } from 'react';

interface ProGateProps {
  feature: string;
  variant?: 'page' | 'inline';
  children: ReactNode;
  fallback?: ReactNode;
}

// DeepSeno Desktop is permanently free — no PRO tiering on the desktop app.
// ProGate kept as a transparent wrapper to preserve call sites; if/when
// a real gating model is needed, reintroduce the locked variants here.
export function ProGate({ children }: ProGateProps) {
  return <>{children}</>;
}
