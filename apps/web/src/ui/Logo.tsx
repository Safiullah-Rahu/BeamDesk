/** BeamDesk mark: a screen with a beam of light passing through it. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="bd-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#22d3ee" />
          <stop offset="1" stop-color="#6366f1" />
        </linearGradient>
      </defs>
      <rect x="4" y="8" width="56" height="40" rx="10" fill="url(#bd-g)" />
      <path d="M17 22H45M40 17l5 5-5 5M47 34H19M24 29l-5 5 5 5" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none" />
      <rect x="22" y="52" width="20" height="5" rx="2.5" fill="url(#bd-g)" />
    </svg>
  );
}
