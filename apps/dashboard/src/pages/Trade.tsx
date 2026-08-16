import { useState } from 'react'
import { ArrowRight, Check, CheckCircle2, Clock3, PackageOpen, ShipWheel, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCompanionMutations, useTrade, useTradePlans } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { formatNumber, titleCase } from '../utils'

export function TradePage() {
  const trade = useTrade()
  const plans = useTradePlans()
  const mutations = useCompanionMutations()
  const [hidden, setHidden] = useState<string[]>([])
  if (trade.isLoading || plans.isLoading) return <LoadingState label="Ranking route plans…" />
  const error = trade.error || plans.error
  if (error) return <ErrorState error={error} retry={() => { void trade.refetch(); void plans.refetch() }} />
  if (!trade.data || !plans.data) return null
  const suggestions = trade.data.suggested_routes.filter((item) => !hidden.includes(item.suggestion_id)).slice(0, 5)

  return <div className="page">
    <PageHeader eyebrow="Trade planner" title="Turn shortages into route plans." description="Ranked source-to-destination proposals combine compatible goods. Amounts are bounded by observed surplus and deficit; route feasibility remains unknown." actions={<CatalogBadge catalog={trade.data.catalog} />} />
    <FreshnessBanner meta={trade.data.meta} />
    <section className="panel trade-opportunities"><SectionHeader title="Recommended routes" description="Three to five focused suggestions, prioritized by policy and destination pressure." />
      {suggestions.length ? <div className="route-suggestion-list">{suggestions.map((route, index) => <article className="route-suggestion" key={route.suggestion_id}>
        <div className="route-rank">{index + 1}</div>
        <div className="route-main"><header><span><strong>{route.source_area_name}</strong><ArrowRight size={16} /><strong>{route.destination_area_name}</strong></span><em className={`confidence ${route.confidence}`}>{route.confidence} confidence</em></header>
          <p>{route.reason}</p>
          <div className="route-goods">{route.goods.map((good) => <Link to={`/areas/${route.destination_area_pk}?product=${good.product_guid}`} key={good.product_guid}><PackageOpen size={14} /><span>{good.product_name}</span><b>{formatNumber(good.advisory_amount)}</b></Link>)}</div>
          <small>Companion evidence only · route feasibility unknown · no game-state mutation</small>
        </div>
        <div className="route-controls"><button className="button primary" disabled={!plans.data.campaign_id || mutations.createTradePlan.isPending} onClick={() => plans.data.campaign_id && mutations.createTradePlan.mutate({ route, campaignId: plans.data.campaign_id })}><Check size={14} /> Accept plan</button><button className="button ghost" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'snoozed' }); setHidden((current) => [...current, route.suggestion_id]) }}><Clock3 size={14} /> Snooze</button><button className="icon-button" aria-label="Dismiss route suggestion" onClick={() => { mutations.patchAction.mutate({ id: route.action_id, status: 'dismissed' }); setHidden((current) => [...current, route.suggestion_id]) }}><X size={14} /></button></div>
      </article>)}</div> : <EmptyState title="No new route suggestions" description="Known plans suppress duplicates. New proposals appear when one city has bounded surplus and another has a policy-backed deficit." />}
    </section>

    <section className="panel"><SectionHeader title="Companion-tracked route plans" description="Track what you intend to implement in Anno; the companion never changes routes for you." />
      {plans.data.items.length ? <div className="trade-plan-list">{plans.data.items.map((plan) => <article key={plan.trade_plan_id} className={`trade-plan ${plan.status}`}>
        <span className="product-glyph">{plan.status === 'completed' ? <CheckCircle2 size={17} /> : <ShipWheel size={17} />}</span>
        <div><header><strong>{plan.source_area_name} <ArrowRight size={13} /> {plan.destination_area_name}</strong><em>{titleCase(plan.status)}</em></header><p>{plan.goods.map((item) => `${item.product_name ?? item.product_guid} ${formatNumber(item.amount)}`).join(' · ')}</p><small>{plan.reason || 'Accepted from a deterministic route proposal.'}</small></div>
        <select aria-label={`Status for ${plan.source_area_name} to ${plan.destination_area_name}`} value={plan.status} onChange={(event) => mutations.patchTradePlan.mutate({ id: plan.trade_plan_id, status: event.target.value as typeof plan.status })}><option value="planned">Planned</option><option value="implemented_unverified">Implemented, unverified</option><option value="completed">Completed</option><option value="dismissed">Dismissed</option></select>
      </article>)}</div> : <EmptyState title="No tracked route plans" description="Accept a recommendation above to create a local plan." />}
    </section>
  </div>
}
