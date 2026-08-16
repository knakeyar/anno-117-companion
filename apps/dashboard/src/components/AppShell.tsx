import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Boxes, Factory, Gauge, HeartPulse, PackageSearch, ShipWheel } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useStatus } from '../api'
import { freshnessLabel } from '../utils'
import { AdvisorDrawer } from './AdvisorDrawer'

const navigation = [
  { to: '/', label: 'Command', icon: Gauge, end: true },
  { to: '/trade', label: 'Trade', icon: ShipWheel },
  { to: '/production', label: 'Production', icon: Factory },
  { to: '/areas', label: 'Areas', icon: PackageSearch },
  { to: '/settings', label: 'Health', icon: HeartPulse },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [advisorOpen, setAdvisorOpen] = useState(false)
  useEffect(() => {
    const open = () => setAdvisorOpen(true)
    window.addEventListener('anno:open-advisor', open)
    return () => window.removeEventListener('anno:open-advisor', open)
  }, [])
  const status = useStatus()
  const freshness = status.data?.latest_snapshot
  const tone = !status.data ? 'offline' : freshness?.is_stale ? 'stale' : 'live'

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand" aria-label="Anno Companion">
          <span className="brand-mark"><Boxes size={20} aria-hidden="true" /></span>
          <span>
            <strong>Anno</strong>
            <small>Companion</small>
          </span>
        </div>
        <nav aria-label="Primary navigation">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}>
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <button className="advisor-launch" onClick={() => setAdvisorOpen(true)}><Bot size={17} /><span>Ask advisor</span></button>
        <div className={`connection-card ${tone}`} aria-live="polite">
          <span className="status-dot" />
          <div>
            <strong>{tone === 'live' ? 'Live telemetry' : tone === 'stale' ? 'Telemetry stale' : 'Connecting'}</strong>
            <small>{freshness ? freshnessLabel(freshness.freshness_seconds) : 'Waiting for data service'}</small>
          </div>
        </div>
      </aside>
      <main className="main-content">{children}</main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}>
            <Icon size={19} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <button className="advisor-fab" onClick={() => setAdvisorOpen(true)} aria-label="Ask economic advisor"><Bot size={19} /></button>
      <AdvisorDrawer open={advisorOpen} onClose={() => setAdvisorOpen(false)} />
    </div>
  )
}
