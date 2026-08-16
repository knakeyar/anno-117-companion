import { AlertTriangle, ArrowRight, Banknote, Bot, Check, Clock3, Route, TrendingDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAreas, useCompanionMutations, useFinanceHistory, useOverview, useTradeNetwork, useTradePlans } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { TradeNetworkCards } from '../components/TradeNetworkGraph'
import { formatMoney, formatNumber } from '../utils'

export function CommandCenterPage() {
  const overview = useOverview()
  const areas = useAreas()
  const history = useFinanceHistory()
  const network = useTradeNetwork()
  const plans = useTradePlans()
  const mutations = useCompanionMutations()
  if (overview.isLoading || areas.isLoading || network.isLoading || plans.isLoading) return <LoadingState />
  const error = overview.error || areas.error || network.error || plans.error
  if (error) return <ErrorState error={error} retry={() => { void overview.refetch(); void areas.refetch(); void network.refetch(); void plans.refetch() }} />
  if (!overview.data || !areas.data || !network.data || !plans.data) return null
  const data = overview.data
  const critical = data.actions.filter((item) => item.severity === 'critical').length
  const treasuryPoints = history.data?.items.filter((item) => item.treasury != null) ?? []
  const treasuryMin = Math.min(...treasuryPoints.map((item) => item.treasury!), 0)
  const treasuryMax = Math.max(...treasuryPoints.map((item) => item.treasury!), 1)

  return <div className="page command-page">
    <PageHeader eyebrow="Economy command center" title="Decide what to fix next." description="Persistent campaign facts, ranked actions, and city-specific evidence remain available while Anno is inactive." actions={<div className="header-actions"><button className="button primary" onClick={() => window.dispatchEvent(new Event('anno:open-advisor'))}><Bot size={15} /> Ask advisor</button><CatalogBadge catalog={data.catalog} /></div>} />
    <FreshnessBanner meta={data.meta} />
    <section className="metric-grid clickable-metrics" aria-label="Economy summary">
      <Link to="/#balance" className="metric-card"><span className="metric-label"><Banknote size={16} /> Treasury</span><strong className="metric-value">{formatMoney(data.finance?.treasury)}</strong><small className="metric-supporting">{data.balance_analysis?.treasury_is_falling ? 'Falling over this play session' : 'Participant-wide persisted value'}</small></Link>
      <Link to="/#balance" className={`metric-card ${(data.finance?.total_balance_raw ?? 0) < 0 ? 'critical' : 'positive'}`}><span className="metric-label"><TrendingDown size={16} /> Reported balance</span><strong className="metric-value">{formatMoney(data.finance?.total_balance_raw)}</strong><small className="metric-supporting">Net profit from categories {formatMoney(data.balance_analysis?.category_totals.net_profit)}</small></Link>
      <Link to="/#actions" className={`metric-card ${critical ? 'critical' : 'positive'}`}><span className="metric-label"><AlertTriangle size={16} /> Critical actions</span><strong className="metric-value">{critical}</strong><small className="metric-supporting">{data.actions.length} actionable recommendations</small></Link>
      <Link to="/trade" className={`metric-card ${data.suggested_routes.length ? 'warning' : ''}`}><span className="metric-label"><Route size={16} /> Suggested routes</span><strong className="metric-value">{data.suggested_routes.length}</strong><small className="metric-supporting">Grouped plans · feasibility unknown</small></Link>
    </section>

    <TradeNetworkCards compact network={network.data} areas={areas.data.items} plans={plans.data.items} onLink={(body) => mutations.linkTradeRoute.mutate(body)} onUnlink={(linkId) => mutations.unlinkTradeRoute.mutate(linkId)} onRelink={(linkId, routeKey) => mutations.relinkTradeRoute.mutate({ linkId, routeKey })} />

    <div className="command-grid" id="actions">
      <section className="panel span-two"><SectionHeader title="Top economic actions" description="Deterministic, evidence-backed work ranked before any AI call." action={<Link className="text-link" to="/trade">Open trade plans <ArrowRight size={14} /></Link>} />
        {data.actions.length ? <div className="action-list">{data.actions.slice(0, 6).map((action, index) => <article className={`action-card ${action.severity}`} key={action.action_id}>
          <span className="action-rank">{index + 1}</span><Link to={action.deep_link || '/'}><strong>{action.title}</strong><p>{action.summary}</p><small>{action.kind.replaceAll('_', ' ')} · evidence available</small></Link>
          <div className="action-controls"><button title="Accept" onClick={() => mutations.patchAction.mutate({ id: action.action_id, status: 'accepted' })}><Check size={14} /></button><button title="Snooze" onClick={() => mutations.patchAction.mutate({ id: action.action_id, status: 'snoozed' })}><Clock3 size={14} /></button></div>
        </article>)}</div> : <EmptyState title="No active actions" description="The current observations do not trigger a deterministic intervention." />}
      </section>
      <section className="panel" id="balance"><SectionHeader title="Why balance is changing" description="Reported balance and treasury movement are intentionally separate." />
        {data.balance_analysis ? <div className="balance-analysis">
          <div className="treasury-spark" aria-label="Treasury history">{treasuryPoints.map((point, index) => <i key={`${point.observed_at}-${index}`} style={{ height: `${18 + ((point.treasury! - treasuryMin) / Math.max(1, treasuryMax - treasuryMin)) * 62}%` }} />)}</div>
          {data.balance_analysis.guidance.map((item) => <article key={item.code}><strong>{item.title}</strong><p>{item.suggestion}</p></article>)}
          <div className="profit-summary" aria-label="Observed profit breakdown"><span><small>Gross income</small><strong className="positive">{formatMoney(data.balance_analysis.category_totals.gross_income)}</strong></span><span><small>Gross expenses</small><strong className="negative">{formatMoney(-data.balance_analysis.category_totals.gross_expenses)}</strong></span><span><small>Net profit</small><strong className={data.balance_analysis.category_totals.net_profit < 0 ? 'negative' : 'positive'}>{formatMoney(data.balance_analysis.category_totals.net_profit)}</strong></span></div>
          <small>Net profit is the sum of the currently observed finance categories; reported balance remains the engine authority.</small>
          <dl><div><dt>Passive trade</dt><dd>{formatMoney(data.balance_analysis.trade_balance.passive)}</dd></div><div><dt>Active trade</dt><dd>{formatMoney(data.balance_analysis.trade_balance.active)}</dd></div><div><dt>Treasury / game min</dt><dd>{formatNumber(data.balance_analysis.treasury_change_per_game_minute, 1)}</dd></div></dl>
          <div className="finance-category"><span>Estimated base factory maintenance</span><b>{formatMoney(data.balance_analysis.estimated_base_maintenance.total)}</b></div>
          <small>{data.balance_analysis.estimated_base_maintenance.notice}</small>
          <h3>Largest expenses</h3>{data.balance_analysis.largest_negative_categories.slice(0, 4).map((item) => <div className="finance-category" key={`${item.kind}-${item.ordinal}`}><span>{item.localized_label || item.category_guid_raw || 'Unknown category'}</span><b>{formatMoney(item.value)}</b></div>)}
        </div> : <EmptyState title="No finance observation" description="Finance guidance appears after a complete participant snapshot." />}
      </section>
    </div>
  </div>
}
