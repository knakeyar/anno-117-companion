import { useState } from 'react'
import { AlertTriangle, ArrowRight, Check, CheckCircle2, CircleHelp, Clock3, Coins, Copy, Gauge, MapPinned, PackageOpen, Ship, ShipWheel, Timer, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCompanionMutations, useTrade, useTradeNetwork, useTradePlans } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { TradeNetworkExplorer } from '../components/TradeNetworkGraph'
import type { SuggestedRoute, TradePlan } from '../types'
import { formatNumber, titleCase } from '../utils'

interface ShipInputs {
  cargoSlots: number
  roundTripMinutes: string
  shipCost: string
}

const defaultShipInputs: ShipInputs = { cargoSlots: 3, roundTripMinutes: '', shipCost: '' }

function optionalNumber(value: string): number | null {
  const parsed = Number(value)
  return value.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function analyzeShipPlan(route: SuggestedRoute, inputs: ShipInputs) {
  const goods = route.goods.filter((good) => good.advisory_amount != null)
  const roundTrip = optionalNumber(inputs.roundTripMinutes)
  const shipCost = optionalNumber(inputs.shipCost)
  const canSize = route.plan_kind === 'emergency_transfer' || (roundTrip != null && roundTrip > 0)
  const perGood = new Map<string, { target: number; slots: number; safeInitialLoad: number }>()
  let totalSlots: number | null = canSize ? 0 : null
  let totalTarget: number | null = canSize ? 0 : null
  for (const good of goods) {
    if (!canSize || good.advisory_amount == null) continue
    const target = route.plan_kind === 'recurring_supply'
      ? good.advisory_amount * (roundTrip ?? 0)
      : good.advisory_amount
    const slots = Math.ceil(target / 50)
    const sourceBuffer = Math.max(0, (good.source_available_stock ?? 0) - (good.source_protected_target ?? good.source_high_target ?? 0))
    const destinationSpace = Math.max(0, (good.destination_capacity ?? Number.POSITIVE_INFINITY) - (good.destination_available_stock ?? 0))
    perGood.set(good.product_guid, { target, slots, safeInitialLoad: Math.min(target, sourceBuffer, destinationSpace) })
    totalSlots = (totalSlots ?? 0) + slots
    totalTarget = (totalTarget ?? 0) + target
  }
  const ships = totalSlots == null ? null : Math.max(1, Math.ceil(totalSlots / Math.max(1, inputs.cargoSlots)))
  const fleetCost = ships != null && shipCost != null ? ships * shipCost : null
  const totalRate = route.plan_kind === 'recurring_supply'
    ? goods.reduce((total, good) => total + (good.advisory_amount ?? 0), 0)
    : null
  return { roundTrip, shipCost, perGood, totalSlots, totalTarget, ships, fleetCost, totalRate }
}

function signedRate(value: number | null | undefined) {
  if (value == null) return 'unknown'
  return `${value > 0 ? '+' : ''}${formatNumber(value, 2)} t/min`
}

export function TradePage() {
  const [planKind, setPlanKind] = useState<TradePlan['plan_kind']>('emergency_transfer')
  const [safetyMarginPercent, setSafetyMarginPercent] = useState(20)
  const trade = useTrade(planKind, safetyMarginPercent / 100)
  const plans = useTradePlans()
  const network = useTradeNetwork()
  const mutations = useCompanionMutations()
  const [hidden, setHidden] = useState<string[]>([])
  const [explaining, setExplaining] = useState<string | null>(null)
  const [shipInputs, setShipInputs] = useState<Record<string, ShipInputs>>({})
  if (trade.isLoading || plans.isLoading || network.isLoading) return <LoadingState label="Reading trade routes…" />
  const error = trade.error || plans.error || network.error
  if (error) return <ErrorState error={error} retry={() => { void trade.refetch(); void plans.refetch(); void network.refetch() }} />
  if (!trade.data || !plans.data || !network.data) return null
  const suggestions = trade.data.suggested_routes.filter((item) => !hidden.includes(item.suggestion_id)).slice(0, 5)
  const updateShipInput = (suggestionId: string, update: Partial<ShipInputs>) => setShipInputs((current) => ({
    ...current,
    [suggestionId]: { ...(current[suggestionId] ?? defaultShipInputs), ...update },
  }))

  return <div className="page">
    <PageHeader eyebrow="Trade planner" title="Turn shortages into route plans." description="Choose a one-time stock movement or a sustainable recurring flow. Every quantity is labeled before you save it." actions={<CatalogBadge catalog={trade.data.catalog} />} />
    <FreshnessBanner meta={trade.data.meta} />
    <TradeNetworkExplorer network={network.data} plans={plans.data.items} onLink={(body) => mutations.linkTradeRoute.mutate(body)} onUnlink={(linkId) => mutations.unlinkTradeRoute.mutate(linkId)} onRelink={(linkId, routeKey) => mutations.relinkTradeRoute.mutate({ linkId, routeKey })} />
    <section className="panel trade-opportunities"><SectionHeader title="Recommended routes" description="Changing the plan type recalculates quantities, labels, rationale, and source/destination evidence." />
      <div className="trade-planning-controls">
        <label><span>Recommendation type</span><select aria-label="Recommendation type" value={planKind} onChange={(event) => { setPlanKind(event.target.value as TradePlan['plan_kind']); setExplaining(null) }}><option value="emergency_transfer">One-time transfer</option><option value="recurring_supply">Recurring supply</option></select><small>{planKind === 'emergency_transfer' ? 'Total tons moved once from protected stock.' : 'Sustainable tons/minute; never a guessed per-trip setting.'}</small></label>
        {planKind === 'recurring_supply' && <label><span>Source flow reserve</span><input aria-label="Source flow reserve percent" type="number" min="0" max="95" step="5" value={safetyMarginPercent} onChange={(event) => setSafetyMarginPercent(Math.min(95, Math.max(0, Number(event.target.value) || 0)))} /><small>Percent of observed positive source flow left uncommitted.</small></label>}
      </div>
      {suggestions.length ? <div className="route-suggestion-list">{suggestions.map((route, index) => {
        const inputs = shipInputs[route.suggestion_id] ?? defaultShipInputs
        const analysis = analyzeShipPlan(route, inputs)
        const quantifiedGoods = route.goods.filter((good) => good.advisory_amount != null)
        const displayedTotal = quantifiedGoods.reduce((total, good) => total + (good.advisory_amount ?? 0), 0)
        const isExplaining = explaining === route.suggestion_id
        const isRecurring = route.plan_kind === 'recurring_supply'
        const canSave = route.planning_status === 'ready' && quantifiedGoods.length > 0
        return <article className={`route-suggestion ${isExplaining ? 'explaining' : ''} ${route.planning_status}`} key={route.suggestion_id}>
          <div className="route-rank">{index + 1}</div>
          <div className="route-main"><header><span><strong>{route.source_area_name}</strong><ArrowRight size={16} /><strong>{route.destination_area_name}</strong></span><div className="route-badges"><em className={`plan-kind-badge ${isRecurring ? 'recurring' : 'one-time'}`}>{isRecurring ? 'Recurring supply' : 'One-time transfer'}</em><em className={`confidence ${route.confidence}`}>{route.confidence} confidence</em></div></header>
            <p>{route.reason}</p>
            <div className="route-goods">{route.goods.map((good) => <Link to={`/areas/${route.destination_area_pk}?product=${good.product_guid}`} className={good.advisory_amount == null ? 'unsupported' : ''} key={good.product_guid}><PackageOpen size={14} /><span>{good.product_name}</span><b>{good.advisory_amount == null ? 'Rate unavailable' : `${formatNumber(good.advisory_amount, isRecurring ? 2 : 1)} ${isRecurring ? 't/min' : 't total'}`}</b></Link>)}</div>
            <div className="route-balance-summary">{route.goods.map((good) => <span key={good.product_guid}><strong>{good.product_name}</strong>{good.advisory_amount == null ? ` · ${titleCase(good.blocker ?? 'rate unavailable')}` : isRecurring ? ` · source ${signedRate(good.source_net_stock_change_per_minute)} → ${signedRate(good.projected_source_rate_per_minute)} · destination ${signedRate(good.destination_net_stock_change_per_minute)} → ${signedRate(good.projected_destination_rate_per_minute)} · ${formatNumber(good.committed_export_rate_per_minute, 2)} t/min already committed` : ` · source ${formatNumber(good.source_available_stock)} → ${formatNumber(good.projected_source_stock)}t · destination ${formatNumber(good.destination_available_stock)} → ${formatNumber(good.projected_destination_stock)}t · ${formatNumber(good.source_committed_transfer)}t already committed`}</span>)}</div>
            <div className="route-inline-evidence"><span><MapPinned size={13} />{route.route_distance.value == null ? 'Distance unavailable' : `${formatNumber(route.route_distance.value, 3)} relative map distance`}</span><span><Ship size={13} />{analysis.ships == null ? 'Ship count unknown' : `${analysis.ships} ${analysis.ships === 1 ? 'ship' : 'ships'} (${inputs.cargoSlots} slots each)`}</span><span><Coins size={13} />{analysis.fleetCost == null ? 'Fleet cost unknown' : `${formatNumber(analysis.fleetCost, 2)} fleet cost`}</span></div>
            <small>Companion evidence only · route feasibility unknown · in-game configuration unverified · no game-state mutation</small>
            {isExplaining && <section className="route-explanation" aria-label={`Explanation for ${route.source_area_name} to ${route.destination_area_name}`}>
              <header><span className="product-glyph"><CircleHelp size={17} /></span><div><strong>What saving this plan means</strong><p>{isRecurring ? `Save ${formatNumber(displayedTotal, 2)} t/min of sustainable supply. These are flow budgets, not per-trip settings. Enter a round trip below before using any ship or load estimate.` : `Move ${formatNumber(displayedTotal, 1)} t total once. The listed quantities already reserve existing companion commitments and cannot take the source below its protected target.`}</p></div></header>
              <div className="route-estimates">
                <span><PackageOpen size={15} /><small>{isRecurring ? 'Sustainable export' : 'Total movement'}</small><strong>{formatNumber(displayedTotal, 2)} {isRecurring ? 't/min' : 't total'}</strong></span>
                <span><MapPinned size={15} /><small>Relative distance</small><strong>{route.route_distance.value == null ? 'Unknown' : formatNumber(route.route_distance.value, 3)}</strong></span>
                <span><Gauge size={15} /><small>{isRecurring ? 'Fleet required' : 'One-wave fleet'}</small><strong>{analysis.ships == null ? 'Unknown — add trip time' : `${analysis.ships} × ${inputs.cargoSlots}-slot ship${analysis.ships === 1 ? '' : 's'}`}</strong></span>
                <span><Coins size={15} /><small>Fleet cost</small><strong>{analysis.fleetCost == null ? 'Unknown — add ship cost' : formatNumber(analysis.fleetCost, 2)}</strong></span>
              </div>
              <div className="ship-assumption-grid">
                <label><span>Cargo slots per ship</span><input aria-label={`Cargo slots for ${route.source_area_name} to ${route.destination_area_name}`} type="number" min="1" max="20" step="1" value={inputs.cargoSlots} onChange={(event) => updateShipInput(route.suggestion_id, { cargoSlots: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })} /><small>Each good uses separate slots; every slot holds at most 50t.</small></label>
                <label><span>Expected round trip (min)</span><input aria-label={`Round trip for ${route.source_area_name} to ${route.destination_area_name}`} type="number" min="0.1" step="0.5" placeholder="Unknown" value={inputs.roundTripMinutes} onChange={(event) => updateShipInput(route.suggestion_id, { roundTripMinutes: event.target.value })} /><small>Include both directions, loading, delays, and transitions. Required for recurring load/fleet sizing.</small></label>
                <label><span>Cost per ship</span><input aria-label={`Ship cost for ${route.source_area_name} to ${route.destination_area_name}`} type="number" min="0" step="100" placeholder="Unknown" value={inputs.shipCost} onChange={(event) => updateShipInput(route.suggestion_id, { shipCost: event.target.value })} /><small>Use the acquisition or upkeep cost unit that matters to your comparison.</small></label>
              </div>
              <div className="route-cost-note"><Timer size={14} /><span>{isRecurring ? (analysis.roundTrip == null ? 'Per-trip quantities and fleet size are unknown until round-trip time is supplied.' : `${formatNumber(analysis.totalTarget, 2)}t must move each ${formatNumber(analysis.roundTrip, 1)}-minute cycle across ${analysis.totalSlots} separate 50t slots.`) : `${analysis.totalSlots} separate 50t slots are needed to move the total in one wave; a smaller fleet can repeat trips.`}{analysis.fleetCost != null && analysis.totalRate ? ` Cost per supported t/min: ${formatNumber(analysis.fleetCost / analysis.totalRate, 2)}.` : analysis.fleetCost != null && displayedTotal ? ` One-wave ship cost per transferred ton: ${formatNumber(analysis.fleetCost / displayedTotal, 2)}.` : ''} {route.route_distance.value == null ? 'Distance cannot be costed until route timing is known.' : 'Relative distance helps compare cities; the entered round trip—not map distance—drives fleet cost.'}</span></div>
              <div className="route-outcome-list">{route.goods.map((good) => {
                const shipGood = analysis.perGood.get(good.product_guid)
                if (good.advisory_amount == null) return <div className="unsupported" key={good.product_guid}><strong>{good.product_name}</strong><b>Not quantified</b><span><AlertTriangle size={12} /> {titleCase(good.blocker ?? 'insufficient evidence')}. Wait for current stable velocity evidence before creating recurring supply.</span></div>
                return <div key={good.product_guid}>
                  <strong>{good.product_name}</strong><b>{formatNumber(good.advisory_amount, isRecurring ? 2 : 1)} {isRecurring ? 't/min' : 't total'}</b>
                  {isRecurring ? <>
                    <span>{route.source_area_name}: {signedRate(good.source_net_stock_change_per_minute)} observed − {formatNumber(good.committed_export_rate_per_minute, 2)} committed − {formatNumber(good.advisory_amount, 2)} planned = <strong>{signedRate(good.projected_source_rate_per_minute)}</strong> after <small>({formatNumber(good.safety_margin_rate_per_minute, 2)} t/min safety reserve)</small></span>
                    <span>{route.destination_area_name}: {signedRate(good.destination_net_stock_change_per_minute)} observed + {formatNumber(good.committed_import_rate_per_minute, 2)} committed + {formatNumber(good.advisory_amount, 2)} planned = <strong>{signedRate(good.projected_destination_rate_per_minute)}</strong></span>
                    <span>{shipGood ? `${formatNumber(shipGood.target, 2)}t/cycle · ${shipGood.slots} × 50t slot${shipGood.slots === 1 ? '' : 's'}` : 'Per-cycle load unknown'}{shipGood && shipGood.safeInitialLoad < shipGood.target ? ` · initial protected-stock load capped at ${formatNumber(shipGood.safeInitialLoad, 2)}t` : ''}</span>
                  </> : <>
                    <span>{route.source_area_name}: {formatNumber(good.source_available_stock)} now − {formatNumber(good.source_committed_transfer)} committed − {formatNumber(good.advisory_amount)} planned = <strong>{formatNumber(good.projected_source_stock)}t</strong> <small>(protected target {formatNumber(good.source_protected_target)})</small></span>
                    <span>{route.destination_area_name}: {formatNumber(good.destination_available_stock)} now + {formatNumber(good.destination_committed_transfer)} committed + {formatNumber(good.advisory_amount)} planned = <strong>{formatNumber(good.projected_destination_stock)}t</strong> <small>(need target {formatNumber(good.destination_low_target)})</small></span>
                    <span>Production balance: {signedRate(good.source_net_stock_change_per_minute)} before and after. A one-time transfer changes stored stock, not the ongoing production rate.</span>
                  </>}
                </div>
              })}</div>
            </section>}
          </div>
          <div className="route-controls"><button className="button ghost" aria-expanded={isExplaining} onClick={() => setExplaining(isExplaining ? null : route.suggestion_id)}><CircleHelp size={14} /> {isExplaining ? 'Hide details' : 'Explain plan'}</button><button className="button primary" disabled={!plans.data.campaign_id || !canSave || mutations.createTradePlan.isPending} onClick={() => plans.data.campaign_id && mutations.createTradePlan.mutate({ route, campaignId: plans.data.campaign_id, assumptions: { cargoSlots: inputs.cargoSlots, expectedRoundTripMinutes: analysis.roundTrip, shipCost: analysis.shipCost } })}><Check size={14} /> Save {isRecurring ? 'recurring' : 'one-time'} plan</button><button className="button ghost" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'snoozed' }); setHidden((current) => [...current, route.suggestion_id]) }}><Clock3 size={14} /> Snooze</button><button className="icon-button" aria-label="Dismiss route suggestion" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'dismissed' }); setHidden((current) => [...current, route.suggestion_id]) }}><X size={14} /></button></div>
        </article>
      })}</div> : <EmptyState title={planKind === 'recurring_supply' ? 'No sustainable recurring routes yet' : 'No new one-time transfers'} description={planKind === 'recurring_supply' ? 'Recurring rates require current stable positive source flow and a current stable destination deficit. Learning, stale, or already-committed flow is never quantified.' : 'New proposals appear when one city has uncommitted stock above its protected target and another has remaining need.'} />}
    </section>

    <section className="panel"><SectionHeader title="Saved route checklists" description="These are planning records for changes you make yourself in Anno; saving never changes the game." />
      {plans.data.items.length ? <div className="trade-plan-list">{plans.data.items.map((plan) => <article key={plan.trade_plan_id} className={`trade-plan ${plan.status}`}>
        <span className="product-glyph">{plan.status === 'completed' ? <CheckCircle2 size={17} /> : <ShipWheel size={17} />}</span>
        <div><header><strong>{plan.source_area_name} <ArrowRight size={13} /> {plan.destination_area_name}</strong><em>{titleCase(plan.runtime_status)} · {titleCase(plan.runtime_freshness)}</em></header><p>{plan.goods.map((item) => `${item.product_name ?? item.product_guid} ${formatNumber(item.amount, plan.plan_kind === 'recurring_supply' ? 2 : 1)} ${plan.plan_kind === 'recurring_supply' ? 't/min' : 't total'}`).join(' · ')}</p><div className="trade-plan-route-name"><code>{plan.suggested_route_name}</code><button className="icon-button" aria-label={`Copy ${plan.suggested_route_name}`} onClick={() => navigator.clipboard?.writeText(plan.suggested_route_name)}><Copy size={13} /></button></div><small>{plan.plan_kind === 'recurring_supply' ? 'Recurring supply' : 'One-time transfer'} · {plan.estimated_required_ships == null ? 'ship count unknown' : `${plan.estimated_required_ships} ships · ${plan.total_slots_required} slots`}{plan.estimated_fleet_cost != null ? ` · ${formatNumber(plan.estimated_fleet_cost, 2)} fleet cost` : ''} · {plan.reason || 'Accepted from a deterministic route proposal.'}</small></div>
        <select aria-label={`Status for ${plan.source_area_name} to ${plan.destination_area_name}`} value={plan.status} onChange={(event) => mutations.patchTradePlan.mutate({ id: plan.trade_plan_id, status: event.target.value as typeof plan.status })}><option value="planned">Planned</option><option value="implemented">Implemented</option><option value="implemented_unverified">Implemented, unverified</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option></select>
      </article>)}</div> : <EmptyState title="No tracked route plans" description="Accept a recommendation above to create a local plan." />}
    </section>
  </div>
}
