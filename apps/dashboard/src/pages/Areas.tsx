import { useMemo, useState } from 'react'
import ReactEChartsCoreImport from 'echarts-for-react/lib/core'
import type { ComponentType, CSSProperties } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ArrowRight, Boxes, CircleDollarSign, Crown, Hammer, MapPinned, Pencil, Pickaxe, Scale, Search, UsersRound, Warehouse, Waves, Wheat } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAreas, useChains, useCompanionMutations, useFinance, useHistory, useInventory, useWorkforce } from '../api'
import { EmptyState, ErrorState, FillBar, FreshnessBanner, LoadingState, MetricCard, PageHeader, SectionHeader } from '../components/Common'
import { PolicyEditor } from '../components/PolicyEditor'
import { areaRegion, RegionMap } from '../components/RegionMap'
import type { InventoryItem, ProductionChain } from '../types'
import { formatMoney, formatNumber, formatRate } from '../utils'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

// echarts-for-react publishes this entry point as CommonJS. Vite can expose
// that default export as a module object in a production build even though the
// development transform sees the component directly.
const ReactEChartsCore = (
  typeof ReactEChartsCoreImport === 'object'
    && ReactEChartsCoreImport !== null
    && 'default' in ReactEChartsCoreImport
    ? (ReactEChartsCoreImport as { default: unknown }).default
    : ReactEChartsCoreImport
) as ComponentType<{ echarts: typeof echarts; option: object; style?: CSSProperties }>

const planningDomainOrder = [
  'Construction materials',
  'Raw & agricultural materials',
  'Intermediate goods',
  'Consumer & finished goods',
]

const resourceRegions: Record<string, { name: string; guid: string }> = {
  Roman: { name: 'Latium', guid: '3225' },
  Celtic: { name: 'Albion', guid: '6626' },
}

const workforceOrder = ['2181', '2184', '2185', '2186', '2192', '2196', '2197', '2198', '2199']

interface StockPickerGroup {
  key: string
  label: string
  regionGuid: string | null
  workforceGuid: string | null
  items: InventoryItem[]
}

function stockPickerGroups(items: InventoryItem[], chains: ProductionChain[] | undefined, areaRegionGuid: string | null): StockPickerGroup[] {
  const origins = new Map<string, Array<{ regionId: string; workforceGuid: string | null; workforceName: string }>>()
  for (const chain of chains ?? []) {
    const outputs = chain.items.filter((item) => item.role === 'output')
    for (const output of outputs) {
      const productOrigins = origins.get(output.product_guid) ?? []
      for (const regionId of chain.associated_regions.length ? chain.associated_regions : ['Unknown']) {
        const workforceName = chain.workforce_name ?? (chain.workforce_guid ? `Workforce ${chain.workforce_guid}` : 'Workforce not classified')
        if (!productOrigins.some((origin) => origin.regionId === regionId && origin.workforceGuid === chain.workforce_guid)) {
          productOrigins.push({ regionId, workforceGuid: chain.workforce_guid, workforceName })
        }
      }
      origins.set(output.product_guid, productOrigins)
    }
  }

  const groups = new Map<string, StockPickerGroup>()
  for (const item of items) {
    const productOrigins = origins.get(item.product_guid) ?? [{ regionId: 'Unknown', workforceGuid: null, workforceName: 'Workforce not classified' }]
    for (const origin of productOrigins) {
      const region = resourceRegions[origin.regionId]
      const regionName = region?.name ?? 'Other resources'
      const key = `${origin.regionId}:${origin.workforceGuid ?? 'unknown'}`
      const group = groups.get(key) ?? {
        key,
        label: `${regionName} · ${origin.workforceName}`,
        regionGuid: region?.guid ?? null,
        workforceGuid: origin.workforceGuid,
        items: [],
      }
      if (!group.items.some((candidate) => candidate.product_guid === item.product_guid)) group.items.push(item)
      groups.set(key, group)
    }
  }

  return [...groups.values()]
    .map((group) => ({ ...group, items: [...group.items].sort((a, b) => a.product_name.localeCompare(b.product_name)) }))
    .sort((a, b) => {
      const regionRank = (group: StockPickerGroup) => group.regionGuid === areaRegionGuid ? 0 : group.regionGuid ? 1 : 2
      const regionDifference = regionRank(a) - regionRank(b)
      if (regionDifference) return regionDifference
      if (a.regionGuid !== b.regionGuid) return a.label.localeCompare(b.label)
      const workforceRank = (guid: string | null) => {
        const index = guid ? workforceOrder.indexOf(guid) : -1
        return index >= 0 ? index : workforceOrder.length
      }
      return workforceRank(a.workforceGuid) - workforceRank(b.workforceGuid) || a.label.localeCompare(b.label)
    })
}

function planningDomain(item: InventoryItem, chains: ReturnType<typeof useChains>['data']): string {
  if (item.category === 'construction_material') return 'Construction materials'
  const recipes = chains?.chains ?? []
  const producers = recipes.filter((chain) => chain.items.some((part) => part.role === 'output' && part.product_guid === item.product_guid))
  if (producers.some((chain) => !chain.items.some((part) => part.role === 'input'))) return 'Raw & agricultural materials'
  if (recipes.some((chain) => chain.items.some((part) => part.role === 'input' && part.product_guid === item.product_guid))) return 'Intermediate goods'
  return 'Consumer & finished goods'
}

function WorkforceGlyph({ name }: { name: string | null }) {
  const value = (name ?? '').toLowerCase()
  const Icon = value.includes('wader') || value.includes('water') ? Waves
    : value.includes('smith') ? Hammer
      : value.includes('mercator') || value.includes('merchant') ? Scale
        : value.includes('noble') ? Crown
          : value.includes('farmer') || value.includes('agric') ? Wheat
            : value.includes('miner') ? Pickaxe
              : UsersRound
  return <span className="workforce-glyph" aria-hidden="true"><Icon size={18} /></span>
}

function GoodsDomainSection({ domain, items, pressureProducts, initiallyOpen, onEdit }: {
  domain: string
  items: InventoryItem[]
  pressureProducts: Set<string>
  initiallyOpen: boolean
  onEdit: (item: InventoryItem) => void
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen)
  return <details open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}><summary><span>{domain}</span><small>{items.length} goods</small></summary><div className="goods-target-grid">{items.map((item) => <button className={pressureProducts.has(item.product_guid) ? 'has-pressure' : ''} key={item.product_guid} onClick={() => onEdit(item)}>
    <div><span className="product-glyph"><Warehouse size={15} /></span><span><strong>{item.product_name}</strong><small>{item.passive_trade_mode.replaceAll('_', ' ')} · {item.policy_source.replaceAll('_', ' ')}</small></span><b>{formatNumber(item.stock)} / {formatNumber(item.capacity)}</b></div>
    <FillBar value={item.fill_ratio} low={item.capacity ? (item.low_target ?? 0) / item.capacity : null} high={item.capacity ? (item.high_target ?? 0) / item.capacity : null} />
  </button>)}</div></details>
}

export function AreasPage() {
  const areas = useAreas()
  const inventory = useInventory()
  const mutations = useCompanionMutations()
  const [editingMap, setEditingMap] = useState(false)
  if (areas.isLoading || inventory.isLoading) return <LoadingState label="Mapping controlled islands…" />
  const error = areas.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void areas.refetch(); void inventory.refetch() }} />
  if (!areas.data || !inventory.data) return null
  return (
    <div className="page">
      <PageHeader eyebrow="Controlled areas" title="Your cities stay on the map." description="Latium and Albion remain populated from persisted campaign identity even when Anno is inactive." actions={<button className={`button ${editingMap ? 'primary' : 'ghost'}`} onClick={() => setEditingMap((value) => !value)}><Pencil size={14} /> {editingMap ? 'Finish placement' : 'Edit placement'}</button>} />
      <FreshnessBanner meta={inventory.data.meta} />
      {areas.data.items.length ? <div className="regional-map-grid">
        {(['latium', 'albion'] as const).map((region) => <RegionMap key={region} region={region} areas={areas.data!.items.filter((item) => areaRegion(item) === region || (editingMap && areaRegion(item) === null))} signals={inventory.data!.signals} editable={editingMap} onPosition={(areaPk, regionGuid, x, y) => mutations.mapPosition.mutate({ areaPk, region_guid: regionGuid, x, y })} />)}
      </div> : null}
      {areas.data.items.some((item) => areaRegion(item) === null) && !editingMap && <div className="notice warning"><MapPinned size={18} /><div><strong>Some cities are unplaced</strong><span>Use Edit placement to assign cities whose runtime coordinate or region binding was not observed.</span></div></div>}
      {areas.data.items.length ? <div className="area-card-grid">
        {areas.data.items.map((area) => {
          const items = inventory.data.items.filter((item) => item.area_pk === area.area_pk)
          const pressure = inventory.data.signals.filter((signal) => signal.area_pk === area.area_pk)
          return <Link to={`/areas/${area.area_pk}`} className="area-card" key={area.area_pk}>
            <header><span className="area-mark"><MapPinned size={18} /></span><div><h2>{area.name}</h2><p>{area.region_guid ? `Region ${area.region_guid}` : 'Region not yet correlated'}</p></div><ArrowRight size={17} /></header>
            <div className="area-card-stats"><span><strong>{items.length}</strong><small>tracked goods</small></span><span><strong>{pressure.length}</strong><small>pressure signals</small></span></div>
            <div className="mini-goods">{items.slice(0, 3).map((item) => <span key={item.product_guid}><small>{item.product_name}</small><b>{formatNumber(item.stock)}</b></span>)}</div>
          </Link>
        })}
      </div> : <EmptyState title="No controlled areas yet" description="The data service is waiting for a complete production telemetry snapshot." />}
    </div>
  )
}

export function AreaDetailPage() {
  const { areaPk } = useParams()
  const [searchParams] = useSearchParams()
  const areaId = Number(areaPk)
  const areas = useAreas()
  const inventory = useInventory()
  const workforce = useWorkforce()
  const finance = useFinance()
  const chains = useChains()
  const area = areas.data?.items.find((item) => item.area_pk === areaId)
  const areaItems = useMemo(() => inventory.data?.items.filter((item) => item.area_pk === areaId) ?? [], [inventory.data?.items, areaId])
  const [selectedProduct, setSelectedProduct] = useState(() => searchParams.get('product') ?? '')
  const [goodsSearch, setGoodsSearch] = useState('')
  const [editing, setEditing] = useState<InventoryItem | null>(null)
  const suggestedProduct = inventory.data?.signals.find((signal) => signal.area_pk === areaId)?.product_guid
    ?? areaItems.find((item) => (item.stock ?? 0) > 0)?.product_guid
    ?? areaItems[0]?.product_guid
  const effectiveProduct = selectedProduct || suggestedProduct || ''
  const history = useHistory(areaId, effectiveProduct)
  const selected = areaItems.find((item) => item.product_guid === effectiveProduct)
  const workforceItems = workforce.data?.items.filter((item) => item.area_pk === areaId) ?? []
  const pressureProducts = useMemo(() => new Set(inventory.data?.signals.filter((signal) => signal.area_pk === areaId).map((signal) => signal.product_guid) ?? []), [inventory.data?.signals, areaId])
  const goodsGroups = useMemo(() => {
    const needle = goodsSearch.trim().toLowerCase()
    return planningDomainOrder.flatMap((domain) => {
      const items = areaItems
        .filter((item) => planningDomain(item, chains.data) === domain)
        .filter((item) => !needle || item.product_name.toLowerCase().includes(needle))
        .sort((a, b) => a.product_name.localeCompare(b.product_name))
      return items.length ? [{ domain, items }] : []
    })
  }, [areaItems, chains.data, goodsSearch])
  const stockGroups = useMemo(
    () => stockPickerGroups(areaItems, chains.data?.chains, area?.region_guid ?? null),
    [areaItems, chains.data?.chains, area?.region_guid],
  )

  if (areas.isLoading || inventory.isLoading) return <LoadingState />
  const error = areas.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void areas.refetch(); void inventory.refetch() }} />
  if (!area || !inventory.data) return <EmptyState title="Area not found" description="This area may belong to a different campaign or has not been observed yet." action={<Link className="button ghost" to="/areas">Back to areas</Link>} />

  const chart = {
    backgroundColor: 'transparent',
    grid: { left: 42, right: 18, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: (history.data?.items ?? []).map((point) => new Date(point.observed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), axisLabel: { color: '#789094' }, axisLine: { lineStyle: { color: '#2b3d40' } } },
    yAxis: { type: 'value', axisLabel: { color: '#789094' }, splitLine: { lineStyle: { color: '#213235' } } },
    series: [{ name: 'Observed stock', type: 'line', smooth: true, showSymbol: false, areaStyle: { color: 'rgba(217, 166, 78, .12)' }, lineStyle: { color: '#d9a64e', width: 2 }, data: (history.data?.items ?? []).map((point) => point.stock) }],
  }

  return (
    <div className="page">
      <PageHeader eyebrow={area.region_guid ? `Region ${area.region_guid}` : 'Region unconfirmed'} title={area.name} description={`Observed area ${area.area_id} · campaign-scoped identity`} actions={<Link className="button ghost" to="/areas">All areas</Link>} />
      <FreshnessBanner meta={inventory.data.meta} />
      <section className="metric-grid compact">
        <MetricCard label="Tracked goods" value={areaItems.length} icon={<Boxes size={16} />} />
        <MetricCard label="Participant balance" value={formatMoney(finance.data?.finance?.total_balance_raw)} supporting="Participant scope" icon={<CircleDollarSign size={16} />} />
        <MetricCard label="Workforce groups" value={workforceItems.length || 'Not observed'} supporting="Current-camera scope" icon={<UsersRound size={16} />} />
      </section>
      <div className="area-detail-grid">
        <section className="panel span-two">
          <SectionHeader title="Stock history" description="Resources are grouped by producing region and workforce. The city’s own region appears first." action={<label className="history-product-picker"><span>Stock to chart</span><select aria-label="Stock to chart" value={effectiveProduct} onChange={(event) => setSelectedProduct(event.target.value)}>{stockGroups.map((group) => <optgroup label={group.label} key={group.key}>{group.items.map((item) => <option value={item.product_guid} key={`${group.key}:${item.product_guid}`}>{item.product_name} · {item.stock == null ? 'not observed' : `${formatNumber(item.stock)} stock`}</option>)}</optgroup>)}</select></label>} />
          {selected ? <><div className="history-summary"><span><small>Current</small><strong>{formatNumber(selected.stock)}</strong></span><span><small>Capacity</small><strong>{formatNumber(selected.capacity)}</strong></span><span><small>Net stock change</small><strong className={(selected.velocity?.net_stock_change_per_minute ?? 0) < 0 ? 'negative' : 'positive'}>{formatRate(selected.velocity?.net_stock_change_per_minute)}</strong></span></div><ReactEChartsCore echarts={echarts} option={chart} style={{ height: 260 }} /></> : <EmptyState title="No product selected" description="This area has no observed product rows." />}
        </section>
        <section className="panel">
          <SectionHeader title="Current-area workforce" description="Shown only when this was the camera area." />
          {workforceItems.length ? <div className="workforce-list">{workforceItems.map((item) => <div key={item.workforce_guid}><WorkforceGlyph name={item.name} /><span><strong>{item.name || item.workforce_guid}</strong><small>Supply {formatNumber(item.registered_production, 1)} · demand {formatNumber(Math.abs(item.registered_consumption ?? 0), 1)}</small></span><b className={(item.delta_without_buffs ?? 0) < 0 ? 'negative' : 'positive'}>{formatNumber(item.delta_without_buffs, 1)}</b></div>)}</div> : <EmptyState title="Workforce not observed here" description="Move the game camera to this island and wait for a complete snapshot." />}
        </section>
      </div>
      <section className="panel">
        <SectionHeader title="Goods and targets" description="Planning domains are derived from verified recipe roles. Select a good to change companion-only targets." action={<label className="search-field goods-search"><Search size={15} /><input aria-label="Search city goods" value={goodsSearch} onChange={(event) => setGoodsSearch(event.target.value)} placeholder="Find a good" /></label>} />
        {areaItems.length ? <div className="goods-domain-list">{goodsGroups.map((group, index) => <GoodsDomainSection key={group.domain} domain={group.domain} items={group.items} pressureProducts={pressureProducts} initiallyOpen={index === 0 || group.items.some((item) => pressureProducts.has(item.product_guid))} onEdit={setEditing} />)}</div> : <EmptyState title="No inventory observed" description="Wait for the next complete snapshot." />}
      </section>
      <PolicyEditor item={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
