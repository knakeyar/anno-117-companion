import { AlertTriangle, ArrowDownRight, Boxes, TimerOff, Warehouse } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ManagementSignal } from '../types'
import { formatNumber, formatRate } from '../utils'
import { EmptyState } from './Common'

const icons = {
  low_stock: AlertTriangle,
  near_full: Warehouse,
  falling_stock: ArrowDownRight,
  estimated_stockout: TimerOff,
}

export function SignalList({ signals, limit }: { signals: ManagementSignal[]; limit?: number }) {
  const visible = typeof limit === 'number' ? signals.slice(0, limit) : signals
  if (!visible.length) {
    return <EmptyState title="No active stock pressure" description="Observed goods are currently within their management bands." />
  }
  return (
    <div className="signal-list">
      {visible.map((signal, index) => {
        const Icon = icons[signal.code] ?? Boxes
        return (
          <Link className={`signal-row ${signal.severity}`} to={`/areas/${signal.area_pk}`} key={`${signal.code}-${signal.area_pk}-${signal.product_guid}-${index}`}>
            <span className="signal-icon"><Icon size={17} aria-hidden="true" /></span>
            <span className="signal-copy">
              <strong>{signal.product_name} · {signal.area_name}</strong>
              <small>{signal.label}</small>
            </span>
            <span className="signal-evidence">
              <strong>{formatNumber(signal.evidence.available_stock)}</strong>
              <small>{formatRate(signal.evidence.net_stock_change_per_minute)}</small>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
