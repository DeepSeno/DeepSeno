/**
 * Reusable skeleton loading components.
 * Uses the `.skeleton` CSS class from index.css (shimmer animation).
 */

export function Skeleton({
  className = '',
  variant = 'rect',
}: {
  className?: string;
  variant?: 'rect' | 'circle' | 'text';
}) {
  const base = 'skeleton rounded';
  if (variant === 'circle')
    return <div className={`${base} rounded-full ${className}`} />;
  if (variant === 'text') return <div className={`${base} h-3 ${className}`} />;
  return <div className={`${base} ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div className="border border-neutral-100 rounded-lg p-4 space-y-3">
      <Skeleton variant="text" className="w-1/3" />
      <Skeleton variant="text" className="w-full" />
      <Skeleton variant="text" className="w-2/3" />
    </div>
  );
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
