import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, CircleDot, Factory, HelpCircle, Search, Timer } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useChains } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import type { ProductionChain } from '../types'
import { formatNumber, formatRate, velocityStatusLabel } from '../utils'

function productionRegion(regionGuid: string | null): string {
  const value = regionGuid ?? ''
  if (value.includes('3225') || value.includes('3245')) return 'Latium'
  if (value.includes('6626') || value.includes('6627')) return 'Albion'
  return 'Region not confirmed'
}

export function ProductionPage() {
  const chains = useChains()
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [cityPk, setCityPk] = useState<number | null>(() => {
    const value = Number(searchParams.get('city'))
    return Number.isFinite(value) && value > 0 ? value : null
  })
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('chain'))
  const cities = useMemo(() => {
    const values = new Map<number, { area_pk: number; area_name: string; region_guid: string | null }>()
    for (const chain of chains.data?.chains ?? []) for (const city of chain.city_states) values.set(city.area_pk, city)
    return [...values.values()].sort((a, b) => `${a.region_guid}${a.area_name}`.localeCompare(`${b.region_guid}${b.area_name}`))
  }, [chains.data])
  const effectiveCity = cityPk ?? cities[0]?.area_pk ?? null
  const cityGroups = useMemo(() => {
    const grouped = new Map<string, typeof cities>()
    for (const city of cities) {
      const region = productionRegion(city.region_guid)
      grouped.set(region, [...(grouped.get(region) ?? []), city])
    }
    return ['Latium', 'Albion', 'Region not confirmed'].flatMap((region) => {
      const items = grouped.get(region)
      return items?.length ? [{ region, cities: items }] : []
    })
  }, [cities])
  const cityChains = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (chains.data?.chains ?? []).filter((chain) => {
      const city = chain.city_states.find((item) => item.area_pk === effectiveCity)
      return city && (!needle || `${chain.name} ${chain.building_name} ${chain.items.map((item) => item.product_name).join(' ')}`.toLowerCase().includes(needle))
    }).sort((a, b) => {
      const aa = a.city_states.find((item) => item.area_pk === effectiveCity)!
      const bb = b.city_states.find((item) => item.area_pk === effectiveCity)!
      return (bb.inferred_pressures.length - aa.inferred_pressures.length) || ((bb.building_count ?? -1) - (aa.building_count ?? -1))
    })
  }, [chains.data, effectiveCity, search])
  const selected = cityChains.find((item) => item.recipe_id === selectedId) ?? cityChains[0]
  const selectedCity = selected?.city_states.find((item) => item.area_pk === effectiveCity)
  const selectedRegion = productionRegion(selectedCity?.region_guid ?? null)

  if (chains.isLoading) return <LoadingState label="Organizing production by city…" />
  if (chains.error) return <ErrorState error={chains.error} retry={() => void chains.refetch()} />
  if (!chains.data) return null
  return <div className="page">
    <PageHeader eyebrow="Production intelligence" title="Manage each city by chain." description="Installed factories, unknown presence, input pressure, and output congestion are grouped by city—not flattened into one list." actions={<CatalogBadge catalog={chains.data.catalog} />} />
    <FreshnessBanner meta={chains.data.meta} />
    <div className="notice info"><CircleDot size={18} /><div><strong>Stock-derived production view</strong><span>“Net stock change,” “inferred pressure,” and “estimated base maintenance” remain distinct from measured factory output.</span></div></div>
    <div className="city-production-layout">
      <aside className="panel city-browser"><SectionHeader title="Regions and cities" description="Choose a region, then a persisted city." /><div className="region-city-groups">{cityGroups.map((group) => <section key={group.region}><h3>{group.region}</h3>{group.cities.map((city) => {
        const states = chains.data!.chains.map((chain) => chain.city_states.find((item) => item.area_pk === city.area_pk)).filter(Boolean)
        const installed = states.filter((item) => item!.presence_status === 'installed').length
        const unknown = states.filter((item) => item!.presence_status === 'unknown').length
        const pressure = states.reduce((count, item) => count + item!.inferred_pressures.length, 0)
        return <button className={effectiveCity === city.area_pk ? 'active' : ''} key={city.area_pk} onClick={() => { setCityPk(city.area_pk); setSelectedId(null) }}><Factory size={16} /><span><strong>{city.area_name}</strong><small>{installed} installed · {unknown} unknown · {pressure} pressures</small></span>{pressure > 0 && <AlertTriangle size={14} />}</button>
      })}</section>)}</div></aside>
      <section className="panel chain-browser"><SectionHeader title="Factory chains" description={`${selectedRegion} · red means inferred pressure, green means no current pressure.`} />
        <div className="chain-health-legend"><span><i className="presence-dot healthy" />No pressure</span><span><i className="presence-dot pressure" />Pressure</span><span><i className="presence-dot unknown" />Unknown/absent</span></div>
        <label className="search-field full"><Search size={16} /><input aria-label="Search chains" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chains, factories, or goods" /></label>
        <div className="city-chain-list">{cityChains.slice(0, 80).map((chain) => {
          const city = chain.city_states.find((item) => item.area_pk === effectiveCity)!
          const health = city.presence_status !== 'installed' ? 'unknown' : city.inferred_pressures.length ? 'pressure' : 'healthy'
          return <button className={selected?.recipe_id === chain.recipe_id ? 'active' : ''} key={chain.recipe_id} onClick={() => setSelectedId(chain.recipe_id)}><span className={`presence-dot ${health}`} /> <span><strong>{chain.name}</strong><small>{city.presence_status === 'installed' ? `${city.building_count} installed` : city.presence_status.replace('_', ' ')}</small></span>{city.inferred_pressures.length > 0 && <b>{city.inferred_pressures.length}</b>}</button>
        })}</div>
      </section>
      <section className="panel chain-detail"><SectionHeader title={selected?.name || 'Select a chain'} description={selectedCity ? `${selectedRegion} → ${selectedCity.area_name} → factory chain · ${selectedCity.presence_status.replace('_', ' ')}` : 'Region → city → factory-chain evidence'} />
        {selected && selectedCity ? <>
          <div className="factory-node"><Factory size={24} /><div><strong>{selected.building_name || selected.building_guid}</strong><small>{selected.cycle_seconds ? <><Timer size={12} /> {selected.cycle_seconds}s base cycle</> : 'Cycle unknown'} · Estimated base maintenance {formatNumber(selected.base_maintenance)}</small></div><b>{selectedCity.building_count ?? <HelpCircle size={17} />}</b></div>
          <div className="detailed-chain-flow"><div><h3>Inputs</h3>{selectedCity.stocks.filter((item) => item.role === 'input').map((item) => <StockNode item={item} key={`${item.role}-${item.ordinal}`} />)}</div><ArrowRight size={22} /><div><h3>Outputs</h3>{selectedCity.stocks.filter((item) => item.role === 'output').map((item) => <StockNode item={item} key={`${item.role}-${item.ordinal}`} />)}</div></div>
          {selectedCity.inferred_pressures.length ? <div className="chain-evidence">{selectedCity.inferred_pressures.map((item, index) => <Link to={`/areas/${item.area_pk}?product=${item.product_guid}`} key={`${item.code}-${index}`}><AlertTriangle size={15} /><span><strong>{item.chain_issue === 'output_blockage' ? 'Output congestion' : 'Input pressure'}</strong><small>{item.product_name} · {item.label}</small></span><ArrowRight size={14} /></Link>)}</div> : <EmptyState title="No inferred pressure" description="Current stock evidence does not trigger input or output pressure for this city-chain pair." />}
          <small className="measurement-notice">{selected.measurement_notice}</small>
        </> : <EmptyState title="No chain selected" description="Choose a city and chain to inspect its production context." />}
      </section>
    </div>
  </div>
}

function StockNode({ item }: { item: ProductionChain['city_states'][number]['stocks'][number] }) {
  return <article className={(item.fill_ratio ?? .5) < .25 ? 'critical' : (item.fill_ratio ?? 0) > .9 ? 'warning' : ''}><strong>{item.amount}× {item.product_name || item.product_guid}</strong><span>{formatNumber(item.stock)} / {formatNumber(item.capacity)}</span><small>Net stock change {formatRate(item.net_stock_change?.net_stock_change_per_minute)} · {velocityStatusLabel(item.net_stock_change)}</small></article>
}
