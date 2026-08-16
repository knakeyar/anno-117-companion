import { useMemo, useState } from 'react'
import ReactEChartsCoreImport from 'echarts-for-react/lib/core'
import type { ComponentType, CSSProperties } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { AlertTriangle, Boxes, ChevronRight, CircleDollarSign, Crown, Hammer, History, MapPinned, Pickaxe, Scale, UsersRound, Warehouse, Waves, Wheat } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAreas, useFinance, useHistory, useInventory, useStockPlanning, useWorkforce } from '../api'
import { EmptyState, ErrorState, FreshnessBanner, LoadingState, MetricCard, PageHeader, SectionHeader } from '../components/Common'
import type { StockPlanningRow } from '../types'
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

type StockSortKey = 'attention' | 'resource' | 'stock' | 'demand' | 'supply' | 'balance'

const stockStatusRank: Record<StockPlanningRow['status'], number> = {
  deficit: 0,
  constrained: 1,
  neutral: 2,
  healthy: 3,
  unknown: 4,
}

function planningValue(value: number | null, signed = false): string {
  if (value === null) return '—'
  const rendered = formatNumber(Math.abs(value), Math.abs(value) < 10 ? 2 : 1)
  if (!signed || value === 0) return rendered
  return `${value > 0 ? '+' : '−'}${rendered}`
}

function planningVelocityLabel(confidence: string | null): string {
  if (confidence === 'previous_session') return 'Previous session'
  if (confidence === 'provisional') return 'Provisional'
  if (confidence) return 'Stable'
  return 'Awaiting current data'
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
  const planning = useStockPlanning(areaId)
  const workforce = useWorkforce()
  const finance = useFinance()
  const area = areas.data?.items.find((item) => item.area_pk === areaId)
  const areaItems = useMemo(() => inventory.data?.items.filter((item) => item.area_pk === areaId) ?? [], [inventory.data?.items, areaId])
  const requestedProduct = searchParams.get('product') ?? ''
  const [selectedStockGroup, setSelectedStockGroup] = useState('')
  const [selectedHistoryProduct, setSelectedHistoryProduct] = useState(requestedProduct)
  const [sortKey, setSortKey] = useState<StockSortKey>('attention')
  const [sortDescending, setSortDescending] = useState(false)
  const workforceItems = workforce.data?.items.filter((item) => item.area_pk === areaId) ?? []
  const stockGroups = planning.data?.groups ?? []
  const effectiveStockGroup = stockGroups.find((group) => group.key === selectedStockGroup)
    ?? stockGroups.find((group) => group.items.some((item) => item.product_guid === requestedProduct))
    ?? stockGroups[0]
  const selectedHistoryRow = effectiveStockGroup?.items.find((item) => item.product_guid === selectedHistoryProduct)
    ?? effectiveStockGroup?.items.find((item) => item.product_guid === requestedProduct)
  const history = useHistory(areaId, selectedHistoryRow?.product_guid ?? '')

  const sortedRows = useMemo(() => {
    const rows = [...(effectiveStockGroup?.items ?? [])]
    const numberValue = (row: StockPlanningRow): number | null => {
      if (sortKey === 'stock') return row.stock
      if (sortKey === 'demand') return row.demand_per_minute
      if (sortKey === 'supply') return row.supply_per_minute
      if (sortKey === 'balance') return row.balance_per_minute
      return null
    }
    rows.sort((left, right) => {
      let result = 0
      if (sortKey === 'attention') {
        result = stockStatusRank[left.status] - stockStatusRank[right.status]
          || (left.balance_per_minute ?? Number.POSITIVE_INFINITY) - (right.balance_per_minute ?? Number.POSITIVE_INFINITY)
          || left.natural_order - right.natural_order
      } else if (sortKey === 'resource') {
        result = left.resource_name.localeCompare(right.resource_name)
      } else {
        const leftValue = numberValue(left)
        const rightValue = numberValue(right)
        result = leftValue === null ? 1 : rightValue === null ? -1 : leftValue - rightValue
      }
      return (sortDescending ? -result : result) || left.resource_name.localeCompare(right.resource_name)
    })
    return rows
  }, [effectiveStockGroup, sortDescending, sortKey])

  if (areas.isLoading || inventory.isLoading) return <LoadingState />
  const error = areas.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void areas.refetch(); void inventory.refetch() }} />
  if (!area || !inventory.data) return <EmptyState title="Area not found" description="This area may belong to a different campaign or has not been observed yet." action={<Link className="button ghost" to="/areas">Back to areas</Link>} />

  const historyChart = {
    backgroundColor: 'transparent',
    grid: { left: 44, right: 18, top: 18, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'time', axisLabel: { color: '#789094' }, axisLine: { lineStyle: { color: '#2b3d40' } } },
    yAxis: { type: 'value', axisLabel: { color: '#789094' }, splitLine: { lineStyle: { color: '#213235' } } },
    series: [{
      name: selectedHistoryRow?.resource_name ?? 'Stock',
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: '#d9a64e' },
      areaStyle: { color: 'rgba(217,166,78,.08)' },
      data: (history.data?.items ?? []).map((point) => [point.observed_at, point.stock]),
      connectNulls: false,
    }],
  }

  const changeSort = (next: StockSortKey) => {
    if (sortKey === next) setSortDescending((value) => !value)
    else {
      setSortKey(next)
      setSortDescending(false)
    }
  }

  const sortButton = (label: string, key: StockSortKey) => <button type="button" onClick={() => changeSort(key)} className={sortKey === key ? 'active' : ''} aria-label={`Sort by ${label}`}>
    {label}<span aria-hidden="true">{sortKey === key ? sortDescending ? ' ↓' : ' ↑' : ''}</span>
  </button>

  return (
    <div className="page">
      <PageHeader eyebrow={area.region_guid ? `Region ${area.region_guid}` : 'Region unconfirmed'} title={area.name} description={`Observed area ${area.area_id} · campaign-scoped identity`} actions={<Link className="button ghost" to="/areas">All areas</Link>} />
      <FreshnessBanner meta={inventory.data.meta} />
      <section className="metric-grid compact">
        <MetricCard label="Tracked goods" value={areaItems.length} icon={<Boxes size={16} />} />
        <MetricCard label="Participant balance" value={formatMoney(finance.data?.finance?.total_balance_raw)} supporting="Participant scope" icon={<CircleDollarSign size={16} />} />
        <MetricCard label="Workforce groups" value={workforceItems.length || 'Not observed'} supporting="Current-camera scope" icon={<UsersRound size={16} />} />
      </section>
      <section className="panel city-stock-planning">
        <SectionHeader title="City stock planning" description="Scan stock and modeled capacity by workforce. Deficits are ranked first; select a resource for its observed history and calculation evidence." action={<label className="history-product-picker"><span>Workforce / population</span><select aria-label="Resource workforce" value={effectiveStockGroup?.key ?? ''} onChange={(event) => { setSelectedStockGroup(event.target.value); setSelectedHistoryProduct('') }}>{stockGroups.map((group) => <option value={group.key} key={group.key}>{group.label} · {group.items.length} goods</option>)}</select></label>} />
        {planning.isLoading ? <LoadingState label="Calculating city requirements…" /> : planning.error ? <ErrorState error={planning.error} retry={() => { void planning.refetch() }} /> : effectiveStockGroup ? <>
          <div className="stock-planning-context">
            <div><WorkforceGlyph name={effectiveStockGroup.population_name} /><span><strong>{effectiveStockGroup.population_name ?? effectiveStockGroup.label}</strong><small>{effectiveStockGroup.population === null ? 'Population not observed' : `${formatNumber(effectiveStockGroup.population, 0)} population`} · {effectiveStockGroup.residence_count === null ? 'residences not observed' : `${formatNumber(effectiveStockGroup.residence_count, 1)} residences`} {effectiveStockGroup.residence_count_source === 'estimated_from_population' ? '(estimated)' : ''}</small></span></div>
            <div className="stock-status-summary" aria-label="Resource status summary">
              <span className="deficit"><b>{effectiveStockGroup.status_counts.deficit}</b> deficits</span>
              <span className="constrained"><b>{effectiveStockGroup.status_counts.constrained + effectiveStockGroup.status_counts.neutral}</b> constrained</span>
              <span className="healthy"><b>{effectiveStockGroup.status_counts.healthy}</b> healthy</span>
              <span className="unknown"><b>{effectiveStockGroup.status_counts.unknown}</b> unknown</span>
            </div>
          </div>
          <div className="stock-status-graph" aria-hidden="true">
            {(['deficit', 'constrained', 'neutral', 'healthy', 'unknown'] as const).map((status) => effectiveStockGroup.status_counts[status] ? <span className={status} style={{ flexGrow: effectiveStockGroup.status_counts[status] }} key={status} /> : null)}
          </div>
          {effectiveStockGroup.consumption_setting_source !== 'telemetry' ? <p className="planning-assumption"><AlertTriangle size={13} />Need-consumption setting was not observed in this snapshot; population demand uses the catalog’s Low baseline. Telemetry mod 1.1.4 captures it automatically.</p> : null}
          <div className="stock-planning-table-wrap">
            <table className="stock-planning-table">
              <thead><tr>
                <th className="resource-column">{sortButton('Resource', 'resource')}</th>
                <th className="numeric stock-column">{sortButton('Stock', 'stock')}</th>
                <th className="numeric secondary-column">{sortButton('Demand/min', 'demand')}</th>
                <th className="numeric secondary-column">Per 1k</th>
                <th className="numeric secondary-column">{sortButton('Supply/min', 'supply')}</th>
                <th className="numeric balance-column">{sortButton('Balance/min', 'balance')}</th>
              </tr></thead>
              <tbody>{sortedRows.map((row) => <tr className={`${row.status}${selectedHistoryRow?.product_guid === row.product_guid ? ' selected' : ''}`} key={row.product_guid} onClick={() => setSelectedHistoryProduct(row.product_guid)}>
                <td className="resource-column"><button type="button" className="stock-resource-button" onClick={() => setSelectedHistoryProduct(row.product_guid)} aria-label={`View ${row.resource_name} stock history`}>
                  {row.icon ? <img src={row.icon} alt="" /> : <span className="product-glyph"><Warehouse size={15} /></span>}
                  <span><strong>{row.resource_name}</strong><small>{row.calculation_completeness === 'modeled_base' ? 'Base model' : 'Partial evidence'}</small></span>
                  {row.status === 'deficit' ? <AlertTriangle className="row-warning" size={14} aria-label="Deficit" /> : null}
                </button></td>
                <td className="numeric stock-column"><strong>{planningValue(row.stock)}</strong><small>{row.capacity === null ? 'capacity —' : `of ${planningValue(row.capacity)}`}</small></td>
                <td className="numeric secondary-column"><strong>{planningValue(row.demand_per_minute)}</strong><small>{row.population_demand_per_minute === null ? 'population —' : `${planningValue(row.population_demand_per_minute)} population`} · {row.production_input_demand_per_minute === null ? 'chains —' : `${planningValue(row.production_input_demand_per_minute)} chains`}</small></td>
                <td className="numeric secondary-column"><strong>{planningValue(row.per_1000)}</strong><small>population demand</small></td>
                <td className="numeric secondary-column"><strong>{planningValue(row.supply_per_minute)}</strong><small>base capacity</small></td>
                <td className={`numeric balance-column ${row.status}`}><strong>{planningValue(row.balance_per_minute, true)}</strong><small className={(row.observed_net_stock_change_per_minute ?? 0) < 0 ? 'negative' : row.observed_net_stock_change_per_minute === null ? '' : 'positive'}>Observed stock {formatRate(row.observed_net_stock_change_per_minute)}</small></td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="planning-measurement-notice">{planning.data?.measurement_notice}</p>
          {selectedHistoryRow ? <div className="stock-history-detail">
            <header><span className="product-glyph"><History size={15} /></span><div><strong>{selectedHistoryRow.resource_name} history</strong><small>One resource at a time · {planningVelocityLabel(selectedHistoryRow.velocity_confidence)}</small></div><button type="button" className="button ghost small" onClick={() => setSelectedHistoryProduct('')}>Close</button></header>
            <div className="stock-history-detail-grid">
              <div>{history.isLoading ? <LoadingState label="Loading stock history…" /> : <ReactEChartsCore echarts={echarts} option={historyChart} style={{ height: 230 }} />}</div>
              <aside>
                <span><small>Current stock</small><strong>{planningValue(selectedHistoryRow.stock)}</strong></span>
                <span><small>Observed net change</small><strong className={(selectedHistoryRow.observed_net_stock_change_per_minute ?? 0) < 0 ? 'negative' : 'positive'}>{formatRate(selectedHistoryRow.observed_net_stock_change_per_minute)}</strong></span>
                <span><small>Modeled demand</small><strong>{planningValue(selectedHistoryRow.demand_per_minute)}/min</strong></span>
                <span><small>Base supply</small><strong>{planningValue(selectedHistoryRow.supply_per_minute)}/min</strong></span>
                <details><summary>Calculation evidence</summary><p>Population: {planningValue(selectedHistoryRow.population_demand_per_minute)}/min. Production inputs: {planningValue(selectedHistoryRow.production_input_demand_per_minute)}/min.</p>{selectedHistoryRow.supply_sources.map((source) => <p key={`out:${source.recipe_id}`}>{source.building_count} × {source.building_name}: +{planningValue(source.rate_per_minute)}/min base capacity.</p>)}{selectedHistoryRow.demand_sources.map((source) => <p key={`in:${source.recipe_id}`}>{source.building_count} × {source.building_name}: {planningValue(source.rate_per_minute)}/min base input demand.</p>)}</details>
              </aside>
            </div>
          </div> : null}
        </> : <EmptyState title="No planning group available" description="This city has no observed stock rows for the selected catalog." />}
      </section>
      <section className="panel workforce-panel">
          <SectionHeader title="Current-area workforce" description="Shown only when this was the camera area." />
          {workforceItems.length ? <div className="workforce-list">{workforceItems.map((item) => <div key={item.workforce_guid}><WorkforceGlyph name={item.name} /><span><strong>{item.name || item.workforce_guid}</strong><small>Supply {formatNumber(item.registered_production, 1)} · demand {formatNumber(Math.abs(item.registered_consumption ?? 0), 1)}</small></span><b className={(item.delta_without_buffs ?? 0) < 0 ? 'negative' : 'positive'}>{formatNumber(item.delta_without_buffs, 1)}</b></div>)}</div> : <EmptyState title="Workforce not observed here" description="Move the game camera to this island and wait for a complete snapshot." />}
      </section>
    </div>
  )
}
