export function BootScreen({ title, sub }) {
  return (
    <div className="main" style={{ minHeight: '100vh' }}>
      <div className="view">
        <div className="page-head">
          <span className="eyebrow">Content Engine</span>
          <h1>{title}</h1>
          <p className="lede">{sub}</p>
        </div>
      </div>
    </div>
  )
}
