import { useState } from 'react'
import { AlertTriangle, ArrowRight, Check, CheckCircle2, CircleHelp, Clock3, PackageOpen, PauseCircle, PlayCircle, Search, Ship, ShipWheel, Target, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useActiveTradeRoutes, useCompanionMutations, useTrade, useTradePlans } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { formatNumber, freshnessLabel, titleCase } from '../utils'

export function TradePage() {
  const trade = useTrade()
  const plans = useTradePlans()
  const activeRoutes = useActiveTradeRoutes()
  const mutations = useCompanionMutations()
  const [hidden, setHidden] = useState<string[]>([])
  const [explaining, setExplaining] = useState<string | null>(null)
  const [assumedShipCapacity, setAssumedShipCapacity] = useState(300)
  const [routeSearch, setRouteSearch] = useState('')
  if (trade.isLoading || plans.isLoading || activeRoutes.isLoading) return <LoadingState label="Reading trade routes…" />
  const error = trade.error || plans.error || activeRoutes.error
  if (error) return <ErrorState error={error} retry={() => { void trade.refetch(); void plans.refetch(); void activeRoutes.refetch() }} />
  if (!trade.data || !plans.data || !activeRoutes.data) return null
  const suggestions = trade.data.suggested_routes.filter((item) => !hidden.includes(item.suggestion_id)).slice(0, 5)
  const knownRoutes = activeRoutes.data.items.filter((item) => item.route_name.toLowerCase().includes(routeSearch.trim().toLowerCase()))

  return <div className="page">
    <PageHeader eyebrow="Trade planner" title="Turn shortages into route plans." description="Ranked source-to-destination proposals combine compatible goods. Amounts are bounded by observed surplus and deficit; route feasibility remains unknown." actions={<CatalogBadge catalog={trade.data.catalog} />} />
    <FreshnessBanner meta={trade.data.meta} />
    <section className="panel active-routes-panel"><SectionHeader title="Known active routes" description="Routes backed by ships assigned in Anno. The last complete observation remains visible when the game is closed." action={<div className="active-route-counts"><span><Ship size={13} />{activeRoutes.data.counts.ship_backed_routes} routes</span><span>{activeRoutes.data.counts.assigned_ships} ships</span></div>} />
      <div className="active-route-notice"><CircleHelp size={15} /><span>{activeRoutes.data.identity_notice} Stops, configured goods, and ship cargo are not exposed by this telemetry.</span></div>
      <label className="search-field active-route-search"><Search size={14} /><span className="sr-only">Search known routes</span><input value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} placeholder="Search route names" /></label>
      {knownRoutes.length ? <div className="active-route-list">{knownRoutes.map((route) => <article className={`active-route ${route.status} ${route.issues.length ? 'has-issue' : ''}`} key={route.route_key}>
        <span className="active-route-icon">{route.status === 'running' ? <PlayCircle size={18} /> : route.status === 'issue_reported' ? <AlertTriangle size={18} /> : <PauseCircle size={18} />}</span>
        <div className="active-route-main"><header><strong>{route.route_name}</strong><em className={`route-status ${route.status}`}>{titleCase(route.status)}</em>{route.is_stale && <em className="route-status stale">Historical</em>}</header>
          <p>{route.evidence_kind === 'assigned_ships'
            ? `${route.assigned_ship_count ?? 0} assigned ship${route.assigned_ship_count === 1 ? '' : 's'} · ${route.paused_ship_count ?? 0} paused · session ${route.game_session_guid ?? 'unknown'}`
            : 'This name is visible only because Anno reported a route warning; assigned ships were not observed.'}</p>
          <small>{freshnessLabel(route.freshness_seconds)} · mutable route-name identity</small>
          {route.issues.length > 0 && <div className="active-route-issues">{route.issues.map((issue) => <span key={`${issue.issue_code}-${issue.engine_error_code ?? 'flag'}`}><AlertTriangle size={12} />{issue.label}</span>)}</div>}
          {route.ships.length > 0 && <details><summary>Show {route.ships.length} observed ship{route.ships.length === 1 ? '' : 's'}</summary><div className="active-route-ships">{route.ships.map((ship) => <span key={ship.ship_id}><Ship size={13} /><strong>Ship {ship.ship_id}</strong><small>{ship.is_paused ? 'Paused' : 'Running'} · type GUID {ship.ship_guid ?? 'unknown'}{ship.area_id ? ` · last area ${ship.area_id}` : ''}</small></span>)}</div></details>}
        </div>
      </article>)}</div> : <EmptyState title={routeSearch ? 'No matching route names' : 'No ship-backed routes observed yet'} description={activeRoutes.data.telemetry_status === 'not_observed' ? 'Install telemetry mod 1.1.1, load a game, and wait for one complete 30-second snapshot. Existing issue-only names will appear when Anno reports warnings.' : 'No ships were assigned to trade routes in the last successful game-session scan.'} />}
    </section>
    <section className="panel trade-opportunities"><SectionHeader title="Recommended routes" description="Three to five focused suggestions, prioritized by policy and destination pressure." />
      {suggestions.length ? <div className="route-suggestion-list">{suggestions.map((route, index) => {
        const totalCargo = route.goods.reduce((total, good) => total + good.advisory_amount, 0)
        const minimumShips = Math.max(1, Math.ceil(totalCargo / Math.max(1, assumedShipCapacity)))
        const isExplaining = explaining === route.suggestion_id
        return <article className={`route-suggestion ${isExplaining ? 'explaining' : ''}`} key={route.suggestion_id}>
        <div className="route-rank">{index + 1}</div>
        <div className="route-main"><header><span><strong>{route.source_area_name}</strong><ArrowRight size={16} /><strong>{route.destination_area_name}</strong></span><em className={`confidence ${route.confidence}`}>{route.confidence} confidence</em></header>
          <p>{route.reason}</p>
          <div className="route-goods">{route.goods.map((good) => <Link to={`/areas/${route.destination_area_pk}?product=${good.product_guid}`} key={good.product_guid}><PackageOpen size={14} /><span>{good.product_name}</span><b>{formatNumber(good.advisory_amount)}</b></Link>)}</div>
          <small>Companion evidence only · route feasibility unknown · no game-state mutation</small>
          {isExplaining && <section className="route-explanation" aria-label={`Explanation for ${route.source_area_name} to ${route.destination_area_name}`}>
            <header><span className="product-glyph"><CircleHelp size={17} /></span><div><strong>What saving this plan means</strong><p>Create or edit a route in Anno from {route.source_area_name} to {route.destination_area_name}, then configure exactly the goods below. The companion only saves your checklist.</p></div></header>
            <div className="route-estimates">
              <span><PackageOpen size={15} /><small>One dispatch</small><strong>{formatNumber(totalCargo)} t planned</strong></span>
              <span><Ship size={15} /><small>Minimum ship estimate</small><strong>{minimumShips} at {formatNumber(assumedShipCapacity)} t each</strong></span>
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
        <div className="route-controls"><button className="button ghost" aria-expanded={isExplaining} onClick={() => setExplaining(isExplaining ? null : route.suggestion_id)}><CircleHelp size={14} /> {isExplaining ? 'Hide details' : 'Explain plan'}</button><button className="button primary" disabled={!plans.data.campaign_id || mutations.createTradePlan.isPending} onClick={() => plans.data.campaign_id && mutations.createTradePlan.mutate({ route, campaignId: plans.data.campaign_id })}><Check size={14} /> Save plan</button><button className="button ghost" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'snoozed' }); setHidden((current) => [...current, route.suggestion_id]) }}><Clock3 size={14} /> Snooze</button><button className="icon-button" aria-label="Dismiss route suggestion" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'dismissed' }); setHidden((current) => [...current, route.suggestion_id]) }}><X size={14} /></button></div>
      </article>})}</div> : <EmptyState title="No new route suggestions" description="Known plans suppress duplicates. New proposals appear when one city has bounded surplus and another has a policy-backed deficit." />}
    </section>

    <section className="panel"><SectionHeader title="Saved route checklists" description="These are planning records for changes you make yourself in Anno; saving never changes the game." />
      {plans.data.items.length ? <div className="trade-plan-list">{plans.data.items.map((plan) => <article key={plan.trade_plan_id} className={`trade-plan ${plan.status}`}>
        <span className="product-glyph">{plan.status === 'completed' ? <CheckCircle2 size={17} /> : <ShipWheel size={17} />}</span>
        <div><header><strong>{plan.source_area_name} <ArrowRight size={13} /> {plan.destination_area_name}</strong><em>{titleCase(plan.status)}</em></header><p>{plan.goods.map((item) => `${item.product_name ?? item.product_guid} ${formatNumber(item.amount)}`).join(' · ')}</p><small>{plan.reason || 'Accepted from a deterministic route proposal.'}</small></div>
        <select aria-label={`Status for ${plan.source_area_name} to ${plan.destination_area_name}`} value={plan.status} onChange={(event) => mutations.patchTradePlan.mutate({ id: plan.trade_plan_id, status: event.target.value as typeof plan.status })}><option value="planned">Planned</option><option value="implemented_unverified">Implemented, unverified</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option></select>
      </article>)}</div> : <EmptyState title="No tracked route plans" description="Accept a recommendation above to create a local plan." />}
    </section>
  </div>
}
