import type { ReactNode } from 'react'
import { AlertTriangle, BookOpenCheck, CircleAlert, LoaderCircle, Radio, RefreshCw } from 'lucide-react'
import type { CatalogSummary, ObservationMeta } from '../types'
import { freshnessLabel } from '../utils'

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function FreshnessBanner({ meta }: { meta: ObservationMeta }) {
  if (meta.snapshot_id == null) {
    return (
      <div className="notice warning" role="status">
        <Radio size={18} aria-hidden="true" />
        <div><strong>Waiting for the first complete snapshot</strong><span>Start Anno with the production telemetry mod enabled.</span></div>
      </div>
    )
  }
  if (meta.is_stale) {
    return (
      <div className="notice warning" role="status">
        <AlertTriangle size={18} aria-hidden="true" />
        <div><strong>Telemetry is stale</strong><span>{freshnessLabel(meta.freshness_seconds)}. Values remain historical; nothing has been reset to zero.</span></div>
      </div>
    )
  }
  return (
    <div className="freshness-inline" aria-label={freshnessLabel(meta.freshness_seconds)}>
      <span className="status-dot" /> {freshnessLabel(meta.freshness_seconds)}
    </div>
  )
}

export function CatalogBadge({ catalog }: { catalog: CatalogSummary }) {
  return (
    <span className={`catalog-badge coverage-${catalog.coverage}`} title={catalog.coverage_note ?? undefined}>
      <BookOpenCheck size={15} aria-hidden="true" />
      {catalog.products} goods · {catalog.recipes} verified chains
    </span>
  )
}

export function MetricCard({
  label,
  value,
  supporting,
  tone = 'neutral',
  icon,
}: {
  label: string
  value: ReactNode
  supporting?: ReactNode
  tone?: 'neutral' | 'positive' | 'warning' | 'critical'
  icon?: ReactNode
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-label">{icon}{label}</div>
      <strong className="metric-value">{value}</strong>
      {supporting && <div className="metric-supporting">{supporting}</div>}
    </article>
  )
}

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-header">
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {action}
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <CircleAlert size={25} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function LoadingState({ label = 'Loading management data…' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={20} /> {label}</div>
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="notice critical" role="alert">
      <AlertTriangle size={18} />
      <div><strong>Data could not be loaded</strong><span>{error.message}</span></div>
      {retry && <button className="button ghost" onClick={retry}><RefreshCw size={15} /> Retry</button>}
    </div>
  )
}

export function FillBar({ value, low, high }: { value: number | null; low?: number | null; high?: number | null }) {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, value * 100))
  return (
    <div className="fill-track" aria-label={value == null ? 'Capacity unknown' : `${Math.round(percent)}% full`}>
      {low != null && <span className="target low" style={{ left: `${Math.min(100, low * 100)}%` }} />}
      {high != null && <span className="target high" style={{ left: `${Math.min(100, high * 100)}%` }} />}
      <span className={`fill-value ${percent >= 90 ? 'near-full' : percent <= 25 ? 'low' : ''}`} style={{ width: `${percent}%` }} />
    </div>
  )
}

