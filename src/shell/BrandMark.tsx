import { useId } from 'react';

/** Private Browser's own shield. Original artwork; no third-party marks. */
export function BrandMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-fill`} x1="5" y1="2" x2="19" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <path d="M12 2.3c2.4 1.8 4.9 2.5 7.6 2.8v5.5c0 5.2-3 8.4-7.6 10.4-4.6-2-7.6-5.2-7.6-10.4V5.1c2.7-.3 5.2-1 7.6-2.8Z" fill={`url(#${id}-fill)`} />
      <path d="m8.6 12.1 2.3 2.3 4.6-5" fill="none" stroke="#f0fdfa" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
