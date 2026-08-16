import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AlertTriangle, MapPin, Move } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { Area, ManagementSignal } from '../types'

export type RegionKey = 'latium' | 'albion'

export function areaRegion(area: Area): RegionKey | null {
  const value = `${area.region_guid ?? ''} ${area.game_session_guid ?? ''}`.toLowerCase()
  if (value.includes('3225') || value.includes('3245') || value.includes('roman') || value.includes('latium')) return 'latium'
  if (value.includes('6626') || value.includes('6627') || value.includes('celtic') || value.includes('albion')) return 'albion'
  return null
}

function severityFor(areaPk: number, signals: ManagementSignal[]): 'critical' | 'warning' | 'stable' {
  const relevant = signals.filter((item) => item.area_pk === areaPk)
  if (relevant.some((item) => item.severity === 'critical')) return 'critical'
  return relevant.length ? 'warning' : 'stable'
}

function normalizeObserved(areas: Area[]): Map<number, { x: number; y: number }> {
  const observed = areas.filter((item) => item.position && item.position_source === 'telemetry')
  const xs = observed.map((item) => item.position!.x)
  const ys = observed.map((item) => item.position!.y)
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 1)
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 1)
  return new Map(areas.flatMap((area, index) => {
    if (!area.position) return []
    if (area.position_source === 'manual') return [[area.area_pk, area.position]]
    const x = maxX === minX ? .25 + (index % 4) * .16 : .1 + ((area.position.x - minX) / (maxX - minX)) * .8
    const y = maxY === minY ? .3 + (Math.floor(index / 4) % 3) * .2 : .12 + ((area.position.y - minY) / (maxY - minY)) * .76
    return [[area.area_pk, { x, y }]]
  }))
}

export function RegionMap({ region, areas, signals, compact = false, editable = false, onPosition }: {
  region: RegionKey
  areas: Area[]
  signals: ManagementSignal[]
  compact?: boolean
  editable?: boolean
  onPosition?: (areaPk: number, regionGuid: string, x: number, y: number) => void
}) {
  const navigate = useNavigate()
  const [placing, setPlacing] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const positioned = useMemo(() => normalizeObserved(areas), [areas])
  const unplaced = areas.filter((item) => !item.position)
  const regionGuid = region === 'latium' ? '3225' : '6626'

  const locate = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    }
  }
  const place = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!editable || placing == null || !onPosition) return
    const point = locate(event)
    onPosition(placing, regionGuid, point.x, point.y)
    setPlacing(null)
  }

  return <section className={`region-map ${region} ${compact ? 'compact' : ''}`} aria-label={`${region === 'latium' ? 'Latium' : 'Albion'} city map`}>
    <header><div><strong>{region === 'latium' ? 'Latium' : 'Albion'}</strong><small>{areas.length} persisted cities</small></div>{editable && <span><Move size={13} /> Edit placement</span>}</header>
    <svg viewBox="0 0 800 430" role="img" onClick={place} onPointerUp={(event) => {
      if (dragging != null && onPosition) {
        const point = locate(event)
        onPosition(dragging, regionGuid, point.x, point.y)
      }
      setDragging(null)
    }}>
      <title>{region === 'latium' ? 'Latium' : 'Albion'} schematic with clickable cities</title>
      <defs><filter id={`glow-${region}`}><feGaussianBlur stdDeviation="7" /></filter></defs>
      {region === 'latium' ? <>
        <path className="map-water" d="M0 0h800v430H0z" />
        <path className="map-land" d="M40 86C132 22 252 42 322 109c56 53 98 42 152 15 97-49 224-17 280 72-52 5-73 34-105 72-61 73-150 61-222 35-70-25-113-4-166 42-68 59-163 31-211-28 31-37 45-70 28-111-20-50-17-87-36-120Z" />
        <path className="map-road" d="M100 226C219 155 330 247 436 177s207-19 272 32M185 90c54 83 72 170 32 251M555 105c-26 83-21 166 59 235" />
      </> : <>
        <path className="map-water" d="M0 0h800v430H0z" />
        <path className="map-land" d="M51 142c44-76 147-110 231-70 70 33 104 7 169-17 89-33 223 20 291 112-66 8-105 47-134 91-43 66-111 98-184 66-67-29-108-12-166 34-68 54-165 7-198-60 36-49 49-89-9-156Z" />
        <path className="map-marsh" d="M92 251c80-50 144-28 205 25s128 33 189-13 139-47 213-1M149 138c80 19 117 72 120 154M502 96c-4 66 22 113 88 149" />
      </>}
      {areas.map((area) => {
        const point = positioned.get(area.area_pk)
        if (!point) return null
        const x = point.x * 800, y = point.y * 430
        const severity = severityFor(area.area_pk, signals)
        return <g key={area.area_pk} className={`city-marker ${severity}`} transform={`translate(${x} ${y})`} role="link" tabIndex={0} aria-label={`${area.name}, ${severity}`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(`/areas/${area.area_pk}`) }} onClick={(event) => { event.stopPropagation(); if (!editable) navigate(`/areas/${area.area_pk}`) }} onPointerDown={(event) => { if (editable) { event.stopPropagation(); setDragging(area.area_pk); event.currentTarget.setPointerCapture(event.pointerId) } }}>
          <circle className="marker-glow" r="20" />
          <circle className="marker-core" r="10" />
          {severity !== 'stable' && <AlertTriangle x={-6} y={-6} width={12} height={12} />}
          <text x="15" y="4">{area.name}</text>
        </g>
      })}
    </svg>
    {editable && unplaced.length > 0 && <div className="unplaced-strip"><MapPin size={14} /><span>Place:</span>{unplaced.map((area) => <button className={placing === area.area_pk ? 'active' : ''} key={area.area_pk} onClick={() => setPlacing(area.area_pk)}>{area.name}</button>)}</div>}
  </section>
}
