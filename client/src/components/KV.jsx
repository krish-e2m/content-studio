/* ---------- small review helper ---------- */
export function KV({ k, v }) {
  return (
    <div className="ob-kv">
      <span className="mini-label" style={{ margin: 0 }}>{k}</span>
      <span className="v">{v || <span className="bb-empty">-</span>}</span>
    </div>
  )
}
