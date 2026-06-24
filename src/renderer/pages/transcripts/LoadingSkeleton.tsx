import { Skeleton } from '../../components/Skeleton';

interface LoadingSkeletonProps {
  tr: Record<string, any>;
}

export default function LoadingSkeleton({ tr }: LoadingSkeletonProps) {
  return (
    <div style={{ height: 'calc(100vh - 8rem)' }}>
      <div className="kz-ph">
        <div>
          <div className="kz-ph__title">{tr.title}</div>
          {tr.desc && <div className="kz-ph__sub">{tr.desc}</div>}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          height: 'calc(100% - 5rem)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow)',
          background: 'var(--bg-card)',
        }}
      >
        {/* Left rail skeleton */}
        <div style={{ width: 320, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', background: 'var(--bg)', flexShrink: 0 }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--line-soft)' }}>
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Skeleton variant="text" className="w-32 h-4" />
                  <Skeleton variant="text" className="w-10" />
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <Skeleton variant="text" className="w-12" />
                  <Skeleton variant="text" className="w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Center skeleton */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-card)' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line-soft)' }}>
            <Skeleton variant="text" className="h-4 w-40 mb-1" />
            <Skeleton variant="text" className="w-56" />
          </div>
          <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} style={{ display: 'flex', justifyContent: i % 2 === 0 ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth: '70%', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Skeleton variant="text" className="w-16" />
                    <Skeleton variant="text" className="w-10" />
                  </div>
                  <Skeleton className={`h-12 ${i % 2 === 0 ? 'w-48' : 'w-64'} rounded-lg`} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}>
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
