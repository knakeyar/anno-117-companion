import { useMemo, useState } from 'react'
import ReactEChartsCoreImport from 'echarts-for-react/lib/core'
import type { ComponentType, CSSProperties } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { Boxes, ChevronRight, CircleDollarSign, Crown, Hammer, MapPinned, Pickaxe, Scale, Search, UsersRound, Warehouse, Waves, Wheat } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAreas, useChains, useFinance, useHistoryGroup, useInventory, useWorkforce } from '../api'
import { EmptyState, ErrorState, FillBar, FreshnessBanner, LoadingState, MetricCard, PageHeader, SectionHeader } from '../components/Common'
import { PolicyEditor } from '../components/PolicyEditor'
import type { InventoryItem, ProductionChain } from '../types'
import { formatMoney, formatNumber, formatRate } from '../utils'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

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
  if (areas.isLoading || inventory.isLoading) return <LoadingState label="Loading persisted cities…" />
  const error = areas.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void areas.refetch(); void inventory.refetch() }} />
  if (!areas.data || !inventory.data) return null
  const regionGroups = [
    { key: 'latium', name: 'Latium', guids: new Set(['3225', '3245']), items: areas.data.items.filter((area) => ['3225', '3245'].includes(area.region_guid ?? '')) },
    { key: 'albion', name: 'Albion', guids: new Set(['6626', '6627']), items: areas.data.items.filter((area) => ['6626', '6627'].includes(area.region_guid ?? '')) },
    { key: 'unknown', name: 'Region not confirmed', guids: new Set<string>(), items: areas.data.items.filter((area) => !['3225', '3245', '6626', '6627'].includes(area.region_guid ?? '')) },
  ].filter((group) => group.items.length)
  return (
    <div className="page">
      <PageHeader eyebrow="Controlled areas" title="Choose a city to manage." description="Persisted cities remain available after Anno closes. Trade relationships live in the dedicated Trade workspace." />
      <FreshnessBanner meta={inventory.data.meta} />
      {areas.data.items.length ? <div className="region-area-list">{regionGroups.map((group) => <details open key={group.key}><summary><span><MapPinned size={16} /><strong>{group.name}</strong></span><small>{group.items.length} {group.items.length === 1 ? 'city' : 'cities'}</small></summary><div>{group.items.sort((a, b) => a.name.localeCompare(b.name)).map((area) => {
        const items = inventory.data.items.filter((item) => item.area_pk === area.area_pk)
        const pressure = inventory.data.signals.filter((signal) => signal.area_pk === area.area_pk)
        const critical = pressure.filter((signal) => signal.severity === 'critical').length
        return <Link to={`/areas/${area.area_pk}`} className="area-list-row" key={area.area_pk}><span className={`area-severity-dot ${critical ? 'critical' : pressure.length ? 'warning' : 'stable'}`} /><span><strong>{area.name}</strong><small>{area.latest_observation.observed_at ? `Last observed ${new Date(String(area.latest_observation.observed_at)).toLocaleString()}` : 'Awaiting first observation'}</small></span><span className="area-list-stats"><b>{items.length}</b><small>goods</small></span><span className="area-list-stats"><b>{pressure.length}</b><small>pressures</small></span><ChevronRight size={16} /></Link>
      })}</div></details>)}</div> : <EmptyState title="No controlled areas yet" description="The data service is waiting for a complete production telemetry snapshot." />}
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
  const requestedProduct = searchParams.get('product') ?? ''
  const [selectedStockGroup, setSelectedStockGroup] = useState('')
  const [goodsSearch, setGoodsSearch] = useState('')
  const [editing, setEditing] = useState<InventoryItem | null>(null)
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
  const effectiveStockGroup = stockGroups.find((group) => group.key === selectedStockGroup)
    ?? stockGroups.find((group) => group.items.some((item) => item.product_guid === requestedProduct))
    ?? stockGroups[0]
  const groupProductGuids = useMemo(
    () => effectiveStockGroup?.items.map((item) => item.product_guid) ?? [],
    [effectiveStockGroup],
  )
  const history = useHistoryGroup(areaId, groupProductGuids)

  if (areas.isLoading || inventory.isLoading) return <LoadingState />
  const error = areas.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void areas.refetch(); void inventory.refetch() }} />
  if (!area || !inventory.data) return <EmptyState title="Area not found" description="This area may belong to a different campaign or has not been observed yet." action={<Link className="button ghost" to="/areas">Back to areas</Link>} />

  const chart = {
    backgroundColor: 'transparent',
    legend: { type: 'scroll', top: 0, left: 0, right: 0, textStyle: { color: '#a8babc', fontSize: 10 }, pageTextStyle: { color: '#a8babc' }, pageIconColor: '#d9a64e', pageIconInactiveColor: '#52676a' },
    grid: { left: 48, right: 24, top: 62, bottom: 38 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'time', axisLabel: { color: '#789094' }, axisLine: { lineStyle: { color: '#2b3d40' } } },
    yAxis: { type: 'value', axisLabel: { color: '#789094' }, splitLine: { lineStyle: { color: '#213235' } } },
    series: (history.data?.series ?? []).map((series) => ({
      name: effectiveStockGroup?.items.find((item) => item.product_guid === series.product_guid)?.product_name ?? series.product_guid,
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2 },
      data: series.items.map((point) => [point.observed_at, point.stock]),
      connectNulls: false,
    })),
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
      <section className="panel stock-history-panel">
          <SectionHeader title="Stock history by workforce" description="Every resource produced by the selected regional workforce is plotted together. Click legend items to show or hide individual resources." action={<label className="history-product-picker"><span>Resource workforce</span><select aria-label="Resource workforce" value={effectiveStockGroup?.key ?? ''} onChange={(event) => setSelectedStockGroup(event.target.value)}>{stockGroups.map((group) => <option value={group.key} key={group.key}>{group.label} · {group.items.length} goods</option>)}</select></label>} />
          {effectiveStockGroup ? <>{history.isLoading ? <LoadingState label="Loading resource histories…" /> : <><div className="history-series-summary">{effectiveStockGroup.items.map((item) => <span key={item.product_guid}><small>{item.product_name}</small><strong>{formatNumber(item.stock)}</strong><em className={(item.velocity?.net_stock_change_per_minute ?? 0) < 0 ? 'negative' : 'positive'}>{formatRate(item.velocity?.net_stock_change_per_minute)}</em></span>)}</div><ReactEChartsCore echarts={echarts} option={chart} style={{ height: 430 }} /></>}</> : <EmptyState title="No resource group available" description="This area has no observed product rows." />}
      </section>
      <section className="panel workforce-panel">
          <SectionHeader title="Current-area workforce" description="Shown only when this was the camera area." />
          {workforceItems.length ? <div className="workforce-list">{workforceItems.map((item) => <div key={item.workforce_guid}><WorkforceGlyph name={item.name} /><span><strong>{item.name || item.workforce_guid}</strong><small>Supply {formatNumber(item.registered_production, 1)} · demand {formatNumber(Math.abs(item.registered_consumption ?? 0), 1)}</small></span><b className={(item.delta_without_buffs ?? 0) < 0 ? 'negative' : 'positive'}>{formatNumber(item.delta_without_buffs, 1)}</b></div>)}</div> : <EmptyState title="Workforce not observed here" description="Move the game camera to this island and wait for a complete snapshot." />}
      </section>
      <section className="panel">
        <SectionHeader title="Goods and targets" description="Planning domains are derived from verified recipe roles. Select a good to change companion-only targets." action={<label className="search-field goods-search"><Search size={15} /><input aria-label="Search city goods" value={goodsSearch} onChange={(event) => setGoodsSearch(event.target.value)} placeholder="Find a good" /></label>} />
        {areaItems.length ? <div className="goods-domain-list">{goodsGroups.map((group, index) => <GoodsDomainSection key={group.domain} domain={group.domain} items={group.items} pressureProducts={pressureProducts} initiallyOpen={index === 0 || group.items.some((item) => pressureProducts.has(item.product_guid))} onEdit={setEditing} />)}</div> : <EmptyState title="No inventory observed" description="Wait for the next complete snapshot." />}
      </section>
      <PolicyEditor item={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
