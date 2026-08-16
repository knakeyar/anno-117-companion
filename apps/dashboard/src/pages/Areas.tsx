import { useMemo, useState } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ArrowRight, Boxes, CircleDollarSign, MapPinned, Search, UsersRound, Warehouse } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useAreas, useFinance, useHistory, useInventory, useWorkforce } from '../api'
import { EmptyState, ErrorState, FillBar, FreshnessBanner, LoadingState, MetricCard, PageHeader, SectionHeader } from '../components/Common'
import { PolicyEditor } from '../components/PolicyEditor'
import type { InventoryItem } from '../types'
import { formatMoney, formatNumber, formatRate } from '../utils'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

export function AreasPage() {
  const areas = useAreas()
  const inventory = useInventory()
  if (areas.isLoading || inventory.isLoading) return <LoadingState label="Mapping controlled islands…" />
  const error = areas.error || inventory.error
  if (error) return <ErrorState error={error} retry={() => { void areas.refetch(); void inventory.refetch() }} />
  if (!areas.data || !inventory.data) return null
  return (
    <div className="page">
      <PageHeader eyebrow="Controlled areas" title="Every island, one operating picture." description="Area identity is campaign-scoped; region labels appear only after current-camera correlation proves them." />
      <FreshnessBanner meta={inventory.data.meta} />
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
  const areaId = Number(areaPk)
  const areas = useAreas()
  const inventory = useInventory()
  const workforce = useWorkforce()
  const finance = useFinance()
  const area = areas.data?.items.find((item) => item.area_pk === areaId)
  const areaItems = useMemo(() => inventory.data?.items.filter((item) => item.area_pk === areaId) ?? [], [inventory.data?.items, areaId])
  const [selectedProduct, setSelectedProduct] = useState('')
  const [editing, setEditing] = useState<InventoryItem | null>(null)
  const effectiveProduct = selectedProduct || areaItems[0]?.product_guid || ''
  const history = useHistory(areaId, effectiveProduct)
  const selected = areaItems.find((item) => item.product_guid === effectiveProduct)
  const workforceItems = workforce.data?.items.filter((item) => item.area_pk === areaId) ?? []

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
          <SectionHeader title="Stock history" description="Complete snapshots from the active play-session authority epoch." action={<select aria-label="History product" value={effectiveProduct} onChange={(event) => setSelectedProduct(event.target.value)}>{areaItems.map((item) => <option value={item.product_guid} key={item.product_guid}>{item.product_name}</option>)}</select>} />
          {selected ? <><div className="history-summary"><span><small>Current</small><strong>{formatNumber(selected.stock)}</strong></span><span><small>Capacity</small><strong>{formatNumber(selected.capacity)}</strong></span><span><small>Net stock change</small><strong className={(selected.velocity?.net_stock_change_per_minute ?? 0) < 0 ? 'negative' : 'positive'}>{formatRate(selected.velocity?.net_stock_change_per_minute)}</strong></span></div><ReactEChartsCore echarts={echarts} option={chart} style={{ height: 260 }} /></> : <EmptyState title="No product selected" description="This area has no observed product rows." />}
        </section>
        <section className="panel">
          <SectionHeader title="Current-area workforce" description="Shown only when this was the camera area." />
          {workforceItems.length ? <div className="workforce-list">{workforceItems.map((item) => <div key={item.workforce_guid}><span><strong>{item.name || item.workforce_guid}</strong><small>Supply {formatNumber(item.registered_production, 1)} · demand {formatNumber(Math.abs(item.registered_consumption ?? 0), 1)}</small></span><b className={(item.delta_without_buffs ?? 0) < 0 ? 'negative' : 'positive'}>{formatNumber(item.delta_without_buffs, 1)}</b></div>)}</div> : <EmptyState title="Workforce not observed here" description="Move the game camera to this island and wait for a complete snapshot." />}
        </section>
      </div>
      <section className="panel">
        <SectionHeader title="Goods and targets" description="Select a row to change companion-only management policy." />
        {areaItems.length ? <div className="goods-target-grid">{areaItems.map((item) => <button key={item.product_guid} onClick={() => setEditing(item)}>
          <div><span className="product-glyph"><Warehouse size={15} /></span><span><strong>{item.product_name}</strong><small>{item.passive_trade_mode.replaceAll('_', ' ')} · {item.policy_source.replaceAll('_', ' ')}</small></span><b>{formatNumber(item.stock)} / {formatNumber(item.capacity)}</b></div>
          <FillBar value={item.fill_ratio} low={item.capacity ? (item.low_target ?? 0) / item.capacity : null} high={item.capacity ? (item.high_target ?? 0) / item.capacity : null} />
        </button>)}</div> : <EmptyState title="No inventory observed" description="Wait for the next complete snapshot." />}
      </section>
      <PolicyEditor item={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
