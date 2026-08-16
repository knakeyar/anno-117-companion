import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, PackageOpen, Search, Warehouse } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useAreas, useProductionExplorer } from '../api'
import { CatalogBadge, EmptyState, ErrorState, FreshnessBanner, LoadingState, PageHeader } from '../components/Common'
import { ProductionChainGraph } from '../components/ProductionChainGraph'
import type { Area, ProductionResourceOption, ProductionStatus } from '../types'
import { formatNumber, formatRate, titleCase } from '../utils'

const cityStorageKey = 'anno-companion:production:selected-city'

function productionRegion(regionGuid: string | null): 'Latium' | 'Albion' | 'Region not confirmed' {
  const value = regionGuid ?? ''
  if (value.includes('3225') || value.includes('3245')) return 'Latium'
  if (value.includes('6626') || value.includes('6627')) return 'Albion'
  return 'Region not confirmed'
}

function initialCity(searchParams: URLSearchParams): number | null {
  const queryValue = Number(searchParams.get('city'))
  if (Number.isFinite(queryValue) && queryValue > 0) return queryValue
  const storedValue = Number(localStorage.getItem(cityStorageKey))
  return Number.isFinite(storedValue) && storedValue > 0 ? storedValue : null
}

function statusLabel(status: ProductionStatus): string {
  if (status === 'missing') return 'Factory missing'
  if (status === 'deficit') return 'Capacity deficit'
  if (status === 'constrained') return 'Near capacity'
  if (status === 'risk') return 'Stock risk'
  if (status === 'import_required') return 'Import required'
  return titleCase(status)
}

const categoryLabels: Record<ProductionResourceOption['category'], string> = {
  consumer_goods: 'Consumer goods',
  intermediate_goods: 'Intermediate goods',
  raw_materials: 'Raw materials',
  construction_materials: 'Construction materials',
}

function ResourcePicker({ options, selectedGuid, onSelect }: {
  options: ProductionResourceOption[]
  selectedGuid: string | null
  onSelect: (productGuid: string) => void
}) {
  const selected = options.find((item) => item.product_guid === selectedGuid)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = options.filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle))
    return (Object.keys(categoryLabels) as ProductionResourceOption['category'][]).flatMap((category) => {
      const items = filtered.filter((item) => item.category === category).sort((left, right) => left.name.localeCompare(right.name))
      return items.length ? [{ category, items }] : []
    })
  }, [options, query])
  return <div className="production-resource-picker">
    <label htmlFor="production-resource-search">Resource</label>
    <div className="production-resource-combobox">
      <Search size={15} />
      <input
        id="production-resource-search"
        role="combobox"
        aria-expanded={open}
        aria-controls="production-resource-results"
        aria-autocomplete="list"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder={selected ? selected.name : 'Search resources...'}
      />
      <button aria-label="Open resource selector" onClick={() => setOpen((value) => !value)}><ChevronDown size={15} /></button>
      {open && <div className="production-resource-results" id="production-resource-results" role="listbox" aria-label="Production resources">
        {groups.map((group) => <section key={group.category}><h3>{categoryLabels[group.category]}</h3>{group.items.map((item) => <button role="option" aria-selected={item.product_guid === selectedGuid} key={item.product_guid} onClick={() => { onSelect(item.product_guid); setQuery(''); setOpen(false) }}>
          {item.icon ? <img src={item.icon} alt="" /> : <span className="product-glyph"><Warehouse size={14} /></span>}
          <span><strong>{item.name}</strong><small>{item.required_rate == null ? 'Automatic demand unavailable' : `${formatNumber(item.required_rate, 2)}/min city demand`} · {formatNumber(item.stock)} stock</small></span>
          {!item.has_local_recipe && <em>Import/raw</em>}
        </button>)}</section>)}
        {!groups.length && <p>No resources match “{query}”.</p>}
      </div>}
    </div>
  </div>
}

function CitySelectors({ areas, areaPk, onSelect }: { areas: Area[]; areaPk: number; onSelect: (areaPk: number) => void }) {
  const selected = areas.find((area) => area.area_pk === areaPk)
  const selectedRegion = productionRegion(selected?.region_guid ?? null)
  const regions = ['Latium', 'Albion', 'Region not confirmed'] as const
  const regionAreas = areas.filter((area) => productionRegion(area.region_guid) === selectedRegion)
  return <div className="production-location-selectors">
    <label>Region<select aria-label="Production region" value={selectedRegion} onChange={(event) => {
      const first = areas.find((area) => productionRegion(area.region_guid) === event.target.value)
      if (first) onSelect(first.area_pk)
    }}>{regions.filter((region) => areas.some((area) => productionRegion(area.region_guid) === region)).map((region) => <option key={region}>{region}</option>)}</select></label>
    <label>City<select aria-label="Production city" value={areaPk} onChange={(event) => onSelect(Number(event.target.value))}>{regionAreas.map((area) => <option value={area.area_pk} key={area.area_pk}>{area.name}</option>)}</select></label>
  </div>
}

export function ProductionPage() {
  const areas = useAreas()
  const [searchParams, setSearchParams] = useSearchParams()
  const [cityPk, setCityPk] = useState<number | null>(() => initialCity(searchParams))
  const [productGuid, setProductGuid] = useState<string | null>(() => searchParams.get('product'))
  const [recipeOverrides, setRecipeOverrides] = useState<Record<string, string>>({})
  const availableAreas = useMemo(() => [...(areas.data?.items ?? [])].sort((left, right) => `${productionRegion(left.region_guid)}${left.name}`.localeCompare(`${productionRegion(right.region_guid)}${right.name}`)), [areas.data])
  const effectiveCity = availableAreas.some((area) => area.area_pk === cityPk) ? cityPk! : availableAreas[0]?.area_pk ?? 0
  const overrideValues = useMemo(() => Object.entries(recipeOverrides).map(([guid, recipe]) => `${guid}:${recipe}`), [recipeOverrides])
  const explorer = useProductionExplorer(effectiveCity, productGuid, overrideValues)
  const effectiveProduct = explorer.data?.root_product_guid ?? productGuid
  useEffect(() => {
    if (!effectiveCity) return
    localStorage.setItem(cityStorageKey, String(effectiveCity))
  }, [effectiveCity])
  const updateUrl = (nextCity: number, nextProduct: string | null) => {
    const next = new URLSearchParams(searchParams)
    next.set('city', String(nextCity))
    if (nextProduct) next.set('product', nextProduct); else next.delete('product')
    setSearchParams(next, { replace: true })
  }
  const chooseCity = (nextCity: number) => {
    setCityPk(nextCity)
    setRecipeOverrides({})
    updateUrl(nextCity, effectiveProduct)
  }
  const chooseProduct = (nextProduct: string) => {
    setProductGuid(nextProduct)
    setRecipeOverrides({})
    updateUrl(effectiveCity, nextProduct)
  }

  if (areas.isLoading || (effectiveCity && explorer.isLoading && !explorer.data)) return <LoadingState label="Calculating the production chain…" />
  if (areas.error) return <ErrorState error={areas.error} retry={() => void areas.refetch()} />
  if (!effectiveCity) return <div className="page"><PageHeader eyebrow="Production calculator" title="Build exactly what your city needs." description="Choose a resource to see every upstream requirement and factory." /><EmptyState title="No persisted cities yet" description="A completed telemetry snapshot is needed before a city production chain can be calculated." /></div>
  if (explorer.error) return <div className="page"><ErrorState error={explorer.error} retry={() => void explorer.refetch()} /></div>
  if (!explorer.data) return null
  const data = explorer.data
  const root = data.resources.find((item) => item.product_guid === data.root_product_guid)
  const status = data.summary.status
  return <div className="page production-page">
    <PageHeader eyebrow="Production calculator" title="Build exactly what your city needs." description="Select a resource to trace its demand through every upstream recipe and compare required capacity with factories installed in this city." actions={<CatalogBadge catalog={data.catalog} />} />
    <FreshnessBanner meta={data.meta} />
    <section className="panel production-toolbar">
      <CitySelectors areas={availableAreas} areaPk={effectiveCity} onSelect={chooseCity} />
      <ResourcePicker options={data.resource_options} selectedGuid={effectiveProduct} onSelect={chooseProduct} />
    </section>
    {root ? <section className={`production-chain-summary status-${status}`} aria-label="Selected resource summary">
      <div className="production-summary-resource">{root.icon ? <img src={root.icon} alt="" /> : <span className="product-glyph"><PackageOpen size={21} /></span>}<span><small>Selected resource</small><strong>{root.name}</strong></span></div>
      <dl><div><dt>Required</dt><dd>{data.summary.required_rate == null ? 'Unknown' : formatRate(data.summary.required_rate)}</dd></div><div><dt>Base capacity</dt><dd>{data.summary.available_rate == null ? 'Unknown' : formatRate(data.summary.available_rate)}</dd></div><div><dt>Net capacity</dt><dd className={(data.summary.capacity_balance_rate ?? 0) < 0 ? 'negative' : ''}>{data.summary.capacity_balance_rate == null ? 'Unknown' : formatRate(data.summary.capacity_balance_rate)}</dd></div><div><dt>Root factories</dt><dd>{formatNumber(data.summary.required_buildings, 2)} req. · {formatNumber(data.summary.installed_buildings)} built</dd></div></dl>
      <span className={`production-summary-status status-${status}`}>{['healthy', 'neutral'].includes(status) ? null : <AlertTriangle size={13} />}{statusLabel(status)} · {data.summary.bottleneck_count} constraint{data.summary.bottleneck_count === 1 ? '' : 's'}</span>
    </section> : <EmptyState title="No resource selected" description="Search for a resource to calculate its production chain." />}
    {root && <ProductionChainGraph data={data} onRoot={chooseProduct} onRecipe={(guid, recipe) => setRecipeOverrides((current) => ({ ...current, [guid]: recipe }))} />}
    <details className="production-methodology"><summary>Calculation scope</summary><p>{data.measurement_notice}</p><p>Construction and active-project demand remain unknown until validated telemetry exposes them; the calculator never substitutes guessed values.</p></details>
  </div>
}
