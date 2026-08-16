import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Boxes, CircleDot, Factory, Search, Timer, Warehouse } from 'lucide-react'
import { useChains, useInventory } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FillBar, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { SignalList } from '../components/SignalList'
import { formatNumber, formatRate } from '../utils'

export function ProductionPage() {
  const chains = useChains()
  const inventory = useInventory()
  const [search, setSearch] = useState('')
  const filteredChains = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return (chains.data?.chains ?? []).filter((chain) =>
      !needle || `${chain.name} ${chain.building_name} ${chain.items.map((item) => item.product_name).join(' ')}`.toLowerCase().includes(needle),
    )
  }, [chains.data?.chains, search])
  const constructionGoods = (inventory.data?.items ?? []).filter((item) => item.category === 'construction_material')

  if (chains.isLoading || inventory.isLoading) return <LoadingState label="Building production intelligence…" />
  const error = chains.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void chains.refetch(); void inventory.refetch() }} />
  if (!chains.data || !inventory.data) return null

  return (
    <div className="page">
      <PageHeader
        eyebrow="Production intelligence"
        title="Read the pressure, not a fictional rate."
        description="Combine verified recipe relationships with observed stocks to identify input risk and blocked outputs."
        actions={<CatalogBadge catalog={chains.data.catalog} />}
      />
      <FreshnessBanner meta={chains.data.meta} />
      <div className="notice info">
        <CircleDot size={18} />
        <div><strong>Stock-derived production view</strong><span>Signals are inferred pressure from inventory history. Anno’s UI-selected statistics are deliberately excluded from island facts.</span></div>
      </div>

      <div className="production-layout">
        <section className="panel chain-browser">
          <SectionHeader title="Verified production chains" description="Versioned reference data; missing relationships stay unknown." />
          <label className="search-field full"><Search size={16} /><span className="sr-only">Search production chains</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chains, buildings, or goods" /></label>
          {filteredChains.length ? <div className="chain-list">
            {filteredChains.map((chain) => <article className="chain-card" key={chain.recipe_id}>
              <header><span className="product-glyph"><Factory size={18} /></span><div><h3>{chain.name}</h3><p>{chain.building_name || chain.building_guid}</p></div>{chain.cycle_seconds != null && <span className="cycle"><Timer size={14} /> {chain.cycle_seconds}s</span>}</header>
              <div className="chain-flow">
                <div>{chain.items.filter((item) => item.role === 'input').map((item) => <span key={`${item.role}-${item.ordinal}`}><b>{item.amount}×</b>{item.product_name || item.product_guid}</span>)}</div>
                <ArrowRight size={19} />
                <div>{chain.items.filter((item) => item.role === 'output').map((item) => <span key={`${item.role}-${item.ordinal}`}><b>{item.amount}×</b>{item.product_name || item.product_guid}</span>)}</div>
              </div>
              {chain.inferred_pressures.length > 0 && <div className="chain-pressure-list" aria-label="Island-specific chain pressure">
                {chain.inferred_pressures.map((pressure, index) => <div className="chain-pressure" key={`${pressure.chain_issue}-${pressure.area_pk}-${pressure.product_guid}-${index}`}>
                  <AlertTriangle size={15} />
                  <span><strong>{pressure.chain_issue === 'output_blockage' ? 'Output blockage' : 'Input pressure'}</strong> · {pressure.product_name} · {pressure.area_name}</span>
                </div>)}
              </div>}
              <small className="measurement-notice">{chain.measurement_notice}</small>
            </article>)}
          </div> : <EmptyState
            title={chains.data.catalog.recipes === 0 ? 'Recipe catalog awaiting verified data' : 'No matching chains'}
            description={chains.data.catalog.coverage_note || 'Import a versioned recipe catalog to activate dependency analysis. The stock pressure board remains fully operational.'}
          />}
        </section>

        <aside className="panel pressure-board">
          <SectionHeader title="Inferred pressure" description="Construction goods across controlled islands." />
          {constructionGoods.length ? <div className="goods-board">
            {constructionGoods.map((item) => <article key={`${item.area_pk}-${item.product_guid}`}>
              <div className="goods-title"><span className="product-glyph"><Boxes size={15} /></span><span><strong>{item.product_name}</strong><small>{item.area_name}</small></span><b>{formatNumber(item.stock)}</b></div>
              <FillBar value={item.fill_ratio} low={item.capacity ? (item.low_target ?? 0) / item.capacity : null} high={item.capacity ? (item.high_target ?? 0) / item.capacity : null} />
              <div className="goods-meta"><span><Warehouse size={13} /> {Math.round((item.fill_ratio ?? 0) * 100)}% full</span><span className={(item.velocity?.net_stock_change_per_minute ?? 0) < 0 ? 'negative' : 'positive'}>Net stock change {formatRate(item.velocity?.net_stock_change_per_minute)}</span></div>
            </article>)}
          </div> : <EmptyState title="No construction stock observed" description="The starter telemetry catalog has not produced a complete inventory snapshot yet." />}
        </aside>
      </div>

      <section className="panel">
        <SectionHeader title="Production attention queue" description="Low inputs, near-full outputs, and sustained falling stock remain distinct signals." />
        <SignalList signals={inventory.data.signals} />
      </section>
    </div>
  )
}
