// Minimal inline stroke icons (no icon-library dependency).
const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export const Icon = {
  Home: (p) => (
    <svg {...base} className="ico" {...p}>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  ),
  Bulb: (p) => (
    <svg {...base} className="ico" {...p}>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z" />
    </svg>
  ),
  Pen: (p) => (
    <svg {...base} className="ico" {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  ),
  Image: (p) => (
    <svg {...base} className="ico" {...p}>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  ),
  Calendar: (p) => (
    <svg {...base} className="ico" {...p}>
      <rect x="3" y="4" width="18" height="17" rx="1.5" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </svg>
  ),
  Arrow: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  Plus: (p) => (
    <svg {...base} {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Spark: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  ),
  Copy: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a1 1 0 0 1 1-1h10" />
    </svg>
  ),
  Chevron: (p) => (
    <svg {...base} {...p}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  Search: (p) => (
    <svg {...base} className="ico" {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  Check: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <path d="M5 12l5 5L20 6" />
    </svg>
  ),
  Camera: (p) => (
    <svg {...base} {...p}>
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  ),
  Layers: (p) => (
    <svg {...base} {...p}>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  ),
  Folder: (p) => (
    <svg {...base} {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  FolderOpen: (p) => (
    <svg {...base} {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2" />
      <path d="M3 7.5V18a2 2 0 0 0 2 2h13.5a1.5 1.5 0 0 0 1.45-1.1l1.6-6A1.2 1.2 0 0 0 20.4 11.4H6.2a2 2 0 0 0-1.9 1.4z" />
    </svg>
  ),
  Back: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  ),
  Grid: (p) => (
    <svg {...base} className="ico" width="15" height="15" {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  Menu: (p) => (
    <svg {...base} className="ico" width="16" height="16" {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  // Leaving through a door. Back (a plain left arrow) was standing in for this
  // on the sign-out button, where it read as "previous page".
  SignOut: (p) => (
    <svg {...base} className="ico" width="15" height="15" {...p}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l-4 4 4 4" />
      <path d="M15.5 12H6" />
    </svg>
  ),
  Users: (p) => (
    <svg {...base} {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9" />
    </svg>
  ),
  Heart: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M12 21s-7-4.5-9.5-9C1 9 2.5 5.5 6 5.5c2 0 3.2 1.2 4 2.4.8-1.2 2-2.4 4-2.4 3.5 0 5 3.5 3.5 6.5C19 16.5 12 21 12 21z" />
    </svg>
  ),
  ThumbUp: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M7 10v10H4V10z" />
      <path d="M7 10l4-7c1.2 0 2 .9 2 2v3h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7" />
    </svg>
  ),
  Bubble: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M21 11.5a8 8 0 0 1-11.6 7.2L4 20l1.3-5A8 8 0 1 1 21 11.5z" />
    </svg>
  ),
  Repost: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  Send: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  ),
  Bookmark: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  ),
  // Filled, unlike the rest — it sits on top of a photo, where a hairline
  // outline disappears against a busy frame.
  Play: (p) => (
    <svg {...base} width="16" height="16" fill="currentColor" {...p}>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  ),
  Eye: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  EyeOff: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a18.1 18.1 0 0 1-3.2 4.2" />
      <path d="M14.8 14.9A4 4 0 0 1 9.1 9.2" />
      <path d="M6 6.3C3.6 8.1 2 12 2 12s3.5 7 10 7c1 0 2-.2 2.9-.5" />
    </svg>
  ),
  Trash: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  ),
  // Performance section icons
  BarChart: (p) => (
    <svg {...base} className="ico" {...p}>
      <rect x="3" y="12" width="4" height="9" rx="1" />
      <rect x="10" y="7" width="4" height="14" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  ),
  TrendUp: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M22 7l-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </svg>
  ),
  TrendDown: (p) => (
    <svg {...base} width="16" height="16" {...p}>
      <path d="M22 17l-8.5-8.5-5 5L2 7" />
      <path d="M16 17h6v-6" />
    </svg>
  ),
  Info: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  Lock: (p) => (
    <svg {...base} width="15" height="15" {...p}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
}
