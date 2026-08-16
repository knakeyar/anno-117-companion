import { useState } from 'react'
import { ArrowRight, Check, CheckCircle2, CircleHelp, Clock3, Copy, PackageOpen, Ship, ShipWheel, Target, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCompanionMutations, useTrade, useTradeNetwork, useTradePlans } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { TradeNetworkExplorer } from '../components/TradeNetworkGraph'
import type { TradePlan } from '../types'
import { formatNumber, titleCase } from '../utils'

export function TradePage() {
  const trade = useTrade()
  const plans = useTradePlans()
  const network = useTradeNetwork()
  const mutations = useCompanionMutations()
  const [hidden, setHidden] = useState<string[]>([])
  const [explaining, setExplaining] = useState<string | null>(null)
  const [assumedShipCapacity, setAssumedShipCapacity] = useState(300)
  const [planKinds, setPlanKinds] = useState<Record<string, TradePlan['plan_kind']>>({})
  if (trade.isLoading || plans.isLoading || network.isLoading) return <LoadingState label="Reading trade routes…" />
  const error = trade.error || plans.error || network.error
  if (error) return <ErrorState error={error} retry={() => { void trade.refetch(); void plans.refetch(); void network.refetch() }} />
  if (!trade.data || !plans.data || !network.data) return null
  const suggestions = trade.data.suggested_routes.filter((item) => !hidden.includes(item.suggestion_id)).slice(0, 5)

  return <div className="page">
    <PageHeader eyebrow="Trade planner" title="Turn shortages into route plans." description="Ranked source-to-destination proposals combine compatible goods. Amounts are bounded by observed surplus and deficit; route feasibility remains unknown." actions={<CatalogBadge catalog={trade.data.catalog} />} />
    <FreshnessBanner meta={trade.data.meta} />
    <TradeNetworkExplorer network={network.data} plans={plans.data.items} onLink={(body) => mutations.linkTradeRoute.mutate(body)} onUnlink={(linkId) => mutations.unlinkTradeRoute.mutate(linkId)} onRelink={(linkId, routeKey) => mutations.relinkTradeRoute.mutate({ linkId, routeKey })} />
    <section className="panel trade-opportunities"><SectionHeader title="Recommended routes" description="Three to five focused suggestions, prioritized by policy and destination pressure." />
      {suggestions.length ? <div className="route-suggestion-list">{suggestions.map((route, index) => {
        const totalCargo = route.goods.reduce((total, good) => total + good.advisory_amount, 0)
        const capacityLoads = Math.max(1, Math.ceil(totalCargo / Math.max(1, assumedShipCapacity)))
        const isExplaining = explaining === route.suggestion_id
        const planKind = planKinds[route.suggestion_id] ?? 'emergency_transfer'
        return <article className={`route-suggestion ${isExplaining ? 'explaining' : ''}`} key={route.suggestion_id}>
        <div className="route-rank">{index + 1}</div>
        <div className="route-main"><header><span><strong>{route.source_area_name}</strong><ArrowRight size={16} /><strong>{route.destination_area_name}</strong></span><em className={`confidence ${route.confidence}`}>{route.confidence} confidence</em></header>
          <p>{route.reason}</p>
          <div className="route-goods">{route.goods.map((good) => <Link to={`/areas/${route.destination_area_pk}?product=${good.product_guid}`} key={good.product_guid}><PackageOpen size={14} /><span>{good.product_name}</span><b>{formatNumber(good.advisory_amount)}</b></Link>)}</div>
          <small>Companion evidence only · route feasibility unknown · no game-state mutation</small>
          {isExplaining && <section className="route-explanation" aria-label={`Explanation for ${route.source_area_name} to ${route.destination_area_name}`}>
            <header><span className="product-glyph"><CircleHelp size={17} /></span><div><strong>What saving this plan means</strong><p>Create or edit a route in Anno from {route.source_area_name} to {route.destination_area_name}, select the goods below, and use the quantities as target movements across one or more trips. They are not verified per-trip route settings. The companion only saves your checklist.</p></div></header>
            <div className="route-estimates">
              <span><PackageOpen size={15} /><small>Target movement</small><strong>{formatNumber(totalCargo)} t planned</strong></span>
              <span><Ship size={15} /><small>Capacity loads</small><strong>{capacityLoads} × {formatNumber(assumedShipCapacity)} t</strong></span>
              <span><Target size={15} /><small>Expected immediate result</small><strong>{route.goods.length} deficits reduced</strong></span>
            </div>
            <label className="capacity-assumption"><span>Assumed usable cargo per ship</span><input type="number" min="1" step="50" value={assumedShipCapacity} onChange={(event) => setAssumedShipCapacity(Math.max(1, Number(event.target.value) || 1))} /><small>Planning assumption only. The companion cannot observe ship type, slots, travel time, or loading delays, so sustained fleet size remains unknown.</small></label>
            <div className="route-outcome-list">{route.goods.map((good) => <div key={good.product_guid}>
              <strong>{good.product_name}</strong><b>{formatNumber(good.advisory_amount)} t</b>
              <span>{route.source_area_name}: {formatNumber(good.source_available_stock)} → {formatNumber(good.projected_source_stock)} <small>(keeps high target {formatNumber(good.source_high_target)})</small></span>
              <span>{route.destination_area_name}: {formatNumber(good.destination_available_stock)} → {formatNumber(good.projected_destination_stock)} <small>(toward low target {formatNumber(good.destination_low_target)})</small></span>
            </div>)}</div>
          </section>}
        </div>
        <div className="route-controls"><label className="route-kind-select"><span>Plan type</span><select value={planKind} onChange={(event) => setPlanKinds((current) => ({ ...current, [route.suggestion_id]: event.target.value as TradePlan['plan_kind'] }))}><option value="emergency_transfer">One-time transfer</option><option value="recurring_supply">Recurring supply</option></select></label><button className="button ghost" aria-expanded={isExplaining} onClick={() => setExplaining(isExplaining ? null : route.suggestion_id)}><CircleHelp size={14} /> {isExplaining ? 'Hide details' : 'Explain plan'}</button><button className="button primary" disabled={!plans.data.campaign_id || mutations.createTradePlan.isPending} onClick={() => plans.data.campaign_id && mutations.createTradePlan.mutate({ route, campaignId: plans.data.campaign_id, planKind })}><Check size={14} /> Save plan</button><button className="button ghost" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'snoozed' }); setHidden((current) => [...current, route.suggestion_id]) }}><Clock3 size={14} /> Snooze</button><button className="icon-button" aria-label="Dismiss route suggestion" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'dismissed' }); setHidden((current) => [...current, route.suggestion_id]) }}><X size={14} /></button></div>
      </article>})}</div> : <EmptyState title="No new route suggestions" description="Known plans suppress duplicates. New proposals appear when one city has bounded surplus and another has a policy-backed deficit." />}
    </section>

    <section className="panel"><SectionHeader title="Saved route checklists" description="These are planning records for changes you make yourself in Anno; saving never changes the game." />
      {plans.data.items.length ? <div className="trade-plan-list">{plans.data.items.map((plan) => <article key={plan.trade_plan_id} className={`trade-plan ${plan.status}`}>
        <span className="product-glyph">{plan.status === 'completed' ? <CheckCircle2 size={17} /> : <ShipWheel size={17} />}</span>
        <div><header><strong>{plan.source_area_name} <ArrowRight size={13} /> {plan.destination_area_name}</strong><em>{titleCase(plan.runtime_status)} · {titleCase(plan.runtime_freshness)}</em></header><p>{plan.goods.map((item) => `${item.product_name ?? item.product_guid} ${formatNumber(item.amount)}`).join(' · ')}</p><div className="trade-plan-route-name"><code>{plan.suggested_route_name}</code><button className="icon-button" aria-label={`Copy ${plan.suggested_route_name}`} onClick={() => navigator.clipboard?.writeText(plan.suggested_route_name)}><Copy size={13} /></button></div><small>{titleCase(plan.plan_kind)} · {plan.reason || 'Accepted from a deterministic route proposal.'}</small></div>
        <select aria-label={`Status for ${plan.source_area_name} to ${plan.destination_area_name}`} value={plan.status} onChange={(event) => mutations.patchTradePlan.mutate({ id: plan.trade_plan_id, status: event.target.value as typeof plan.status })}><option value="planned">Planned</option><option value="implemented">Implemented</option><option value="implemented_unverified">Implemented, unverified</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option></select>
      </article>)}</div> : <EmptyState title="No tracked route plans" description="Accept a recommendation above to create a local plan." />}
    </section>
  </div>
}
