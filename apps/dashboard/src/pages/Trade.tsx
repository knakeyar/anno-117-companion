import { useEffect, useMemo, useState } from 'react'
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from '@tanstack/react-table'
import { ArrowDownUp, ArrowRight, Filter, Search, Settings2, ShipWheel } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useInventory, useTrade } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FillBar, FreshnessBanner, LoadingState, PageHeader, SectionHeader } from '../components/Common'
import { PolicyEditor } from '../components/PolicyEditor'
import type { InventoryItem } from '../types'
import { formatDuration, formatNumber, formatRate, titleCase } from '../utils'

const column = createColumnHelper<InventoryItem>()

function usePersistedFilter(key: string, fallback = '') {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? fallback)
  useEffect(() => localStorage.setItem(key, value), [key, value])
  return [value, setValue] as const
}

export function TradePage() {
  const inventory = useInventory()
  const trade = useTrade()
  const [search, setSearch] = usePersistedFilter('anno.trade.search')
  const [areaFilter, setAreaFilter] = usePersistedFilter('anno.trade.area')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'pressure', desc: true }])
  const [editing, setEditing] = useState<InventoryItem | null>(null)

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (inventory.data?.items ?? []).filter((item) =>
      (!areaFilter || String(item.area_pk) === areaFilter)
      && (!needle || `${item.product_name} ${item.area_name}`.toLowerCase().includes(needle)),
    )
  }, [inventory.data?.items, search, areaFilter])
  const areas = useMemo(() => Array.from(new Map((inventory.data?.items ?? []).map((item) => [item.area_pk, item.area_name])).entries()), [inventory.data?.items])

  const columns = useMemo(() => [
    column.accessor('product_name', { header: 'Good', cell: ({ row }) => <div className="table-primary"><strong>{row.original.product_name}</strong><small>{row.original.product_guid}</small></div> }),
    column.accessor('area_name', { header: 'Island', cell: ({ row }) => <Link className="table-link" to={`/areas/${row.original.area_pk}`}>{row.original.area_name}</Link> }),
    column.accessor((row) => row.fill_ratio ?? -1, { id: 'stock', header: 'Stock / capacity', cell: ({ row }) => {
      const item = row.original
      return <div className="stock-cell"><span><strong>{formatNumber(item.stock)}</strong> / {formatNumber(item.capacity)}</span><FillBar value={item.fill_ratio} low={item.capacity ? (item.low_target ?? 0) / item.capacity : null} high={item.capacity ? (item.high_target ?? 0) / item.capacity : null} /></div>
    } }),
    column.accessor((row) => row.velocity?.net_stock_change_per_minute ?? 0, { id: 'velocity', header: 'Net stock change', cell: ({ row }) => <span className={`rate ${(row.original.velocity?.net_stock_change_per_minute ?? 0) < 0 ? 'negative' : 'positive'}`}>{formatRate(row.original.velocity?.net_stock_change_per_minute)}</span> }),
    column.accessor((row) => row.estimated_stockout_minutes ?? Number.MAX_SAFE_INTEGER, { id: 'stockout', header: 'Est. stockout', cell: ({ row }) => formatDuration(row.original.estimated_stockout_minutes) }),
    column.accessor('passive_trade_mode', { header: 'Passive trade', cell: ({ getValue }) => <span className={`mode-badge mode-${getValue()}`}>{titleCase(getValue())}</span> }),
    column.accessor((row) => {
      if (row.available_stock != null && row.low_target != null && row.available_stock < row.low_target) return 3
      if (row.fill_ratio != null && row.fill_ratio >= .9) return 2
      if ((row.velocity?.net_stock_change_per_minute ?? 0) < 0) return 1
      return 0
    }, { id: 'pressure', header: 'Pressure', cell: ({ getValue }) => <span className={`pressure-level p${getValue()}`}>{['Stable', 'Falling', 'Near full', 'Low'][getValue()]}</span> }),
    column.display({ id: 'actions', cell: ({ row }) => <button className="icon-button" title="Edit management policy" aria-label={`Edit ${row.original.product_name} policy for ${row.original.area_name}`} onClick={() => setEditing(row.original)}><Settings2 size={16} /></button> }),
  ], [])

  const table = useReactTable({ data: filtered, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() })

  if (inventory.isLoading || trade.isLoading) return <LoadingState label="Loading trade intelligence…" />
  const error = inventory.error || trade.error
  if (error) return <ErrorState error={error} retry={() => { void inventory.refetch(); void trade.refetch() }} />
  if (!inventory.data || !trade.data) return null

  return (
    <div className="page">
      <PageHeader eyebrow="Trade planner" title="Balance stock across the empire." description="Find shortages, available surplus, and passive-trade configuration without pretending route feasibility is known." actions={<CatalogBadge catalog={inventory.data.catalog} />} />
      <FreshnessBanner meta={inventory.data.meta} />
      <section className="panel trade-opportunities">
        <SectionHeader title="Transfer candidates" description="Advisory amounts stop at the source high target and destination low target." />
        {trade.data.items.length ? <div className="candidate-grid">
          {trade.data.items.map((item) => <article className="candidate-card" key={`${item.product_guid}-${item.source_area_pk}-${item.destination_area_pk}`}>
            <div className="candidate-good"><ShipWheel size={17} /><strong>{item.product_name}</strong><b>{formatNumber(item.advisory_amount)}</b></div>
            <div className="candidate-route"><span>{item.source_area_name}</span><ArrowRight size={16} /><span>{item.destination_area_name}</span></div>
            <small>Route feasibility unknown</small>
          </article>)}
        </div> : <EmptyState title="No transfer candidates" description="Adjust management targets or wait for an island to develop a clear surplus and another a shortage." />}
      </section>

      <section className="panel inventory-table-panel">
        <SectionHeader title="Island inventory matrix" description="Full snapshots with raw passive-trade flags and stock-derived trends." />
        <div className="table-toolbar">
          <label className="search-field"><Search size={16} /><span className="sr-only">Search goods</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search goods or islands" /></label>
          <label className="select-field"><Filter size={15} /><span className="sr-only">Filter island</span><select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}><option value="">All islands</option>{areas.map(([pk, name]) => <option value={pk} key={pk}>{name}</option>)}</select></label>
          <span className="result-count">{filtered.length} observations</span>
        </div>
        {filtered.length ? <div className="table-scroll"><table className="data-table">
          <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}><button disabled={!header.column.getCanSort()} onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getCanSort() && <ArrowDownUp size={12} />}</button></th>)}</tr>)}</thead>
          <tbody>{table.getRowModel().rows.map((row) => <tr key={row.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody>
        </table></div> : <EmptyState title="No matching inventory" description="Clear the current search or island filter." />}
      </section>
      <PolicyEditor item={editing} onClose={() => setEditing(null)} />
    </div>
  )
}
