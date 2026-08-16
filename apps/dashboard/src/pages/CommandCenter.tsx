import { AlertTriangle, ArrowRight, Banknote, Boxes, ShipWheel, TrendingDown, UsersRound, Warehouse } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useOverview } from '../api'
import { CatalogBadge, ErrorState, FreshnessBanner, LoadingState, MetricCard, PageHeader, SectionHeader, EmptyState } from '../components/Common'
import { SignalList } from '../components/SignalList'
import { formatMoney, formatNumber, titleCase } from '../utils'

export function CommandCenterPage() {
  const overview = useOverview()
  if (overview.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} retry={() => void overview.refetch()} />
  if (!overview.data) return null
  const data = overview.data
  const critical = data.signals.filter((signal) => signal.severity === 'critical').length

  return (
    <div className="page command-page">
      <PageHeader
        eyebrow="Economy command center"
        title="Keep every island moving."
        description="One operational view for stock pressure, trade opportunities, workforce, and route health."
        actions={<CatalogBadge catalog={data.catalog} />}
      />
      <FreshnessBanner meta={data.meta} />
      <section className="metric-grid" aria-label="Economy summary">
        <MetricCard label="Treasury" value={formatMoney(data.finance?.treasury)} supporting="Participant-wide" icon={<Banknote size={16} />} />
        <MetricCard
          label="Balance"
          value={formatMoney(data.finance?.total_balance_raw)}
          supporting="Raw game balance"
          tone={(data.finance?.total_balance_raw ?? 0) < 0 ? 'critical' : 'positive'}
          icon={<TrendingDown size={16} />}
        />
        <MetricCard label="Critical pressure" value={critical} supporting={`${data.counts.signals} total signals`} tone={critical ? 'critical' : 'positive'} icon={<AlertTriangle size={16} />} />
        <MetricCard label="Transfer candidates" value={data.counts.transfer_candidates} supporting="Route feasibility unknown" tone={data.counts.transfer_candidates ? 'warning' : 'neutral'} icon={<ShipWheel size={16} />} />
      </section>

      <div className="command-grid">
        <section className="panel span-two">
          <SectionHeader title="Priority queue" description="Observed facts and stock-based inferred pressure, ranked for action." action={<Link className="text-link" to="/trade">Open trade planner <ArrowRight size={14} /></Link>} />
          <SignalList signals={data.signals} limit={8} />
        </section>
        <section className="panel">
          <SectionHeader title="Move stock" description="Potential source-to-destination transfers." />
          {data.transfer_candidates.length ? (
            <div className="transfer-list">
              {data.transfer_candidates.slice(0, 5).map((item) => (
                <div className="transfer-row" key={`${item.product_guid}-${item.source_area_pk}-${item.destination_area_pk}`}>
                  <span className="product-glyph"><Boxes size={17} /></span>
                  <div><strong>{item.product_name}</strong><small>{item.source_area_name} <ArrowRight size={11} /> {item.destination_area_name}</small></div>
                  <b>{formatNumber(item.advisory_amount)}</b>
                </div>
              ))}
              <Link className="button ghost full" to="/trade">Review all candidates</Link>
            </div>
          ) : <EmptyState title="No transfer candidates" description="No observed island is simultaneously above its high target while another is below its low target." />}
        </section>
      </div>

      <div className="command-grid bottom">
        <section className="panel">
          <SectionHeader title="Route warnings" description="Coarse game warnings; names are not stable route IDs." />
          {data.route_issues.length ? <div className="compact-list">
            {data.route_issues.map((issue, index) => <div className={`compact-row ${issue.severity}`} key={`${issue.route_name}-${issue.issue_code}-${index}`}>
              <Warehouse size={17} /><span><strong>{issue.route_name || 'Unnamed route'}</strong><small>{titleCase(issue.issue_code)}</small></span>
            </div>)}
          </div> : <EmptyState title="No route warnings" description="The latest complete snapshot contained no coarse route issues." />}
        </section>
        <section className="panel">
          <SectionHeader title="Current-area workforce" description="Only valid for the camera area at observation time." />
          {data.workforce_shortages.length ? <div className="compact-list">
            {data.workforce_shortages.map((item) => <Link to={`/areas/${item.area_pk}`} className="compact-row critical" key={item.workforce_guid}>
              <UsersRound size={17} /><span><strong>{item.name || item.workforce_guid}</strong><small>{item.area_name} · deficit {formatNumber(Math.abs(item.delta_without_buffs ?? 0), 1)}</small></span>
            </Link>)}
          </div> : <EmptyState title="No observed workforce deficit" description="Either the current camera area is balanced or workforce was not observable in this snapshot." />}
        </section>
      </div>
    </div>
  )
}

