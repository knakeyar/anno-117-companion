import type { Velocity } from './types'

export function formatNumber(value: number | null | undefined, maximumFractionDigits = 0): string {
  if (value == null || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
}

export function formatMoney(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatRate(value: number | null | undefined): string {
  if (value == null) return 'Awaiting sample…'
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatNumber(value, 1)}/min`
}

export function velocityStatusLabel(velocity: Velocity | null | undefined): string {
  if (!velocity) return 'Awaiting current data'
  if (velocity.confidence === 'previous_session') return 'Previous session'
  if (velocity.confidence === 'provisional') return 'Provisional'
  return 'Stable'
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`
  return `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)}h`
}

export function freshnessLabel(seconds: number | null): string {
  if (seconds == null) return 'No complete snapshot'
  if (seconds < 10) return 'Updated just now'
  if (seconds < 60) return `Updated ${Math.round(seconds)}s ago`
  return `Updated ${Math.round(seconds / 60)}m ago`
}

export function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
