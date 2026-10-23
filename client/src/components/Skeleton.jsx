// Shimmer skeletons shown while data loads, in place of a full-screen spinner.
// One `.skel` class does the shimmer; everything else here is just layout that
// mirrors the real component so the swap-in doesn't shift the page.

// Base shimmer block. Sizes accept any CSS length (number → px).
export function Skel({ w = '100%', h = 14, r = 6, className = '', style }) {
  return <span className={`skel ${className}`.trim()} style={{ width: w, height: h, borderRadius: r, ...style }} />
}

// Table body placeholder — reuses the real .idea-table shell (borders/padding)
// so Ideas and Posts share one loading look.
export function TableSkeleton({ rows = 6, cols = 6 }) {
  return (
    <div className="card idea-table-wrap">
      <table className="idea-table skel-table">
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c}>
                  <Skel w={c === 0 ? '75%' : c === cols - 1 ? 62 : '52%'} h={c === 0 ? 14 : 11} />
                  {c === 0 && <Skel w="45%" h={9} style={{ marginTop: 5, opacity: 0.6 }} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// One client chooser card (matches .client-card layout).
function ClientCardSkeleton() {
  return (
    <div className="card client-card skel-card">
      <span className="client-accent skel" style={{ borderRadius: 0 }} />
      <div className="client-head">
        <Skel w={38} h={38} r={6} />
        <Skel w={50} h={20} r={999} />
      </div>
      <Skel w="60%" h={20} style={{ marginTop: 4 }} />
      <Skel w="45%" h={12} style={{ marginTop: 6 }} />
      <div className="client-channels" style={{ marginTop: 10 }}>
        <Skel w={56} h={9} />
        <span className="cc-list" style={{ marginTop: 6 }}>
          <Skel w={66} h={20} r={999} />
          <Skel w={78} h={20} r={999} />
        </span>
      </div>
      <div className="client-foot">
        <Skel w={72} h={12} />
        <Skel w={60} h={10} />
      </div>
    </div>
  )
}

// Full clients-chooser page skeleton, shown at "/" while the client list loads.
// Mirrors the real page's shell (top nav + content column) so the swap-in
// doesn't shift anything.
export function ClientsPageSkeleton() {
  return (
    <div className="app">
      {/* Three cells, matching the real nav's grid so the swap-in doesn't shift
          the brand or the date. */}
      <header className="topnav">
        <div className="tn-left">
          <span className="brand">
            <span className="brand-mark">C</span>
            <span className="brand-name">Content Studio</span>
          </span>
        </div>
        <span />
        <div className="tn-right">
          <Skel w={110} h={10} />
          <Skel w={90} h={26} r={6} />
        </div>
      </header>
      <div className="main">
        <div className="view">
          <div className="page-head">
            <Skel w="min(420px, 60%)" h={30} r={8} />
          </div>
          <div className="list-filters">
            <Skel w={320} h={34} r={8} className="skel-grow" />
            <Skel w={140} h={34} r={8} />
            <Skel w={140} h={34} r={8} />
          </div>
          <div className="client-grid">
            {Array.from({ length: 3 }).map((_, i) => <ClientCardSkeleton key={i} />)}
          </div>
        </div>
      </div>
    </div>
  )
}

// Dashboard: stat tiles + two panels.
export function DashboardSkeleton() {
  return (
    <>
      <div className="stats">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="card stat skel-stat" key={i}>
            <Skel w={44} h={24} r={6} />
            <Skel w="70%" h={10} style={{ marginTop: 6 }} />
          </div>
        ))}
      </div>
      <div className="grid grid-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div className="card card-pad" key={i}>
            <Skel w={80} h={9} />
            <Skel w="55%" h={18} style={{ marginTop: 8 }} />
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              {Array.from({ length: 4 }).map((_, r) => (
                <div className="row" style={{ justifyContent: 'space-between' }} key={r}>
                  <Skel w="50%" h={12} />
                  <Skel w={64} h={12} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// Photo Library masonry grid.
export function GallerySkeleton({ count = 9 }) {
  // Varied heights so the masonry columns look real, not a uniform block.
  const heights = [160, 210, 180, 240, 145, 195, 225, 170, 205]
  return (
    <div className="pl-gallery">
      {Array.from({ length: count }).map((_, i) => (
        <div className="pl-item skel-photo" key={i}>
          <Skel w="100%" h={heights[i % heights.length]} r={0} />
        </div>
      ))}
    </div>
  )
}

// Research topics list rows.
export function ResearchListSkeleton({ rows = 5 }) {
  return (
    <div className="research-list">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="research-item" key={i}>
          <Skel w={`${45 + ((i * 13) % 35)}%`} h={14} />
          <div className="research-actions">
            <Skel w={84} h={26} r={6} />
            <Skel w={28} h={28} r={6} />
            <Skel w={28} h={28} r={6} />
          </div>
        </div>
      ))}
    </div>
  )
}
