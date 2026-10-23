export function StepShell({ n, title, hint, children }) {
  return (
    <div className="step-shell">
      <span className="eyebrow">Step {n}</span>
      <h2 style={{ fontSize: '1.8rem', margin: '8px 0 6px' }}>{title}</h2>
      <p className="muted-text" style={{ fontSize: 13.5, marginBottom: 22 }}>{hint}</p>
      {children}
    </div>
  )
}
