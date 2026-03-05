export function Logo({ className = "", size = 40 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <radialGradient id="d-eye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ff6a00" />
          <stop offset="40%" stopColor="#ff4458" />
          <stop offset="100%" stopColor="#aa1122" stopOpacity="0.6" />
        </radialGradient>
        <radialGradient id="d-eyeglow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ff4458" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#ff4458" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="d-body" x1="50" y1="2" x2="50" y2="98" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1a0812" />
          <stop offset="100%" stopColor="#060308" />
        </linearGradient>
        <linearGradient id="d-stroke" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ff4458" />
          <stop offset="55%" stopColor="#00d9ff" />
          <stop offset="100%" stopColor="#ff4458" />
        </linearGradient>
        <filter id="d-bloom" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="d-edge" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* ── Left horn ── */}
      <polygon points="30,28 22,6 38,22" fill="#ff4458" opacity="0.85" filter="url(#d-edge)" />
      <polygon points="30,28 22,6 38,22" fill="none" stroke="#ff4458" strokeWidth="0.5" strokeOpacity="0.5" />

      {/* ── Right horn ── */}
      <polygon points="70,28 78,6 62,22" fill="#ff4458" opacity="0.85" filter="url(#d-edge)" />
      <polygon points="70,28 78,6 62,22" fill="none" stroke="#ff4458" strokeWidth="0.5" strokeOpacity="0.5" />

      {/* ── Main angular face/mask ── */}
      <polygon
        points="30,28 70,28 84,40 88,60 76,80 62,92 50,96 38,92 24,80 12,60 16,40"
        fill="url(#d-body)"
        stroke="url(#d-stroke)"
        strokeWidth="1.8"
        filter="url(#d-edge)"
      />

      {/* ── Inner bevel ── */}
      <polygon
        points="33,33 67,33 79,43 82,61 72,78 61,88 50,91 39,88 28,78 18,61 21,43"
        fill="none"
        stroke="#ff4458"
        strokeWidth="0.5"
        strokeOpacity="0.18"
      />

      {/* ── Angry brow ridges ── */}
      <line x1="22" y1="46" x2="44" y2="53" stroke="#ff4458" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="78" y1="46" x2="56" y2="53" stroke="#ff4458" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="36" y1="50" x2="44" y2="53" stroke="#ff4458" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.5" />
      <line x1="64" y1="50" x2="56" y2="53" stroke="#ff4458" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.5" />

      {/* ── Eye bloom ── */}
      <ellipse cx="50" cy="62" rx="26" ry="12" fill="url(#d-eyeglow)" />

      {/* ── Eye socket ── */}
      <ellipse cx="50" cy="62" rx="22" ry="11" fill="#050208" />
      <ellipse cx="50" cy="62" rx="22" ry="11" fill="none" stroke="#ff4458" strokeWidth="0.8" strokeOpacity="0.4" />

      {/* ── Iris ── */}
      <ellipse cx="50" cy="62" rx="14" ry="8" fill="url(#d-eye)" filter="url(#d-bloom)" />

      {/* ── Vertical slit pupil ── */}
      <ellipse cx="50" cy="62" rx="3.5" ry="7.5" fill="#000" />

      {/* ── Eye highlight ── */}
      <ellipse cx="46" cy="58" rx="2" ry="1.2" fill="white" fillOpacity="0.35" />

      {/* ── Animated scan line ── */}
      <line x1="28" y1="62" x2="72" y2="62" stroke="#ff6a00" strokeWidth="0.7" strokeOpacity="0.5">
        <animate attributeName="y1" values="54;70;54" dur="2.2s" repeatCount="indefinite" />
        <animate attributeName="y2" values="54;70;54" dur="2.2s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="2.2s" repeatCount="indefinite" />
      </line>

      {/* ── Chin marks ── */}
      <line x1="44" y1="81" x2="50" y2="86" stroke="#ff4458" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.55" />
      <line x1="56" y1="81" x2="50" y2="86" stroke="#ff4458" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.55" />

      {/* ── Temple circuit accents ── */}
      <circle cx="20" cy="60" r="1.5" fill="#00d9ff" opacity="0.6" />
      <circle cx="80" cy="60" r="1.5" fill="#00d9ff" opacity="0.6" />
      <line x1="22" y1="60" x2="28" y2="62" stroke="#00d9ff" strokeWidth="0.6" strokeOpacity="0.35" />
      <line x1="78" y1="60" x2="72" y2="62" stroke="#00d9ff" strokeWidth="0.6" strokeOpacity="0.35" />

      {/* ── Horn tip pulsing dots ── */}
      <circle cx="22" cy="6" r="2" fill="#ff4458">
        <animate attributeName="opacity" values="0.5;1;0.5" dur="1.8s" repeatCount="indefinite" />
      </circle>
      <circle cx="78" cy="6" r="2" fill="#ff4458">
        <animate attributeName="opacity" values="0.5;1;0.5" dur="1.8s" begin="0.9s" repeatCount="indefinite" />
      </circle>

      {/* ── Eye pulse ring ── */}
      <ellipse cx="50" cy="62" rx="14" ry="8" fill="none" stroke="#ff4458" strokeWidth="1.2" strokeOpacity="0">
        <animate attributeName="rx" values="14;24;14" dur="2.8s" repeatCount="indefinite" />
        <animate attributeName="ry" values="8;14;8" dur="2.8s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="2.8s" repeatCount="indefinite" />
      </ellipse>
    </svg>
  );
}
