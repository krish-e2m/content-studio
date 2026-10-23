import { TopNav } from './TopNav.jsx'

// App shell for the client-level pages that live outside a workspace:
// onboarding and the brand brain. When a `client` is supplied the nav shows
// that client's section tabs so you can jump straight into its workspace;
// otherwise only the brand and the crumb render.
export function ChromeShell({ crumb, client, children }) {
  return (
    <div className="app">
      <TopNav client={client} crumb={crumb} />
      <div className="main">{children}</div>
    </div>
  )
}
