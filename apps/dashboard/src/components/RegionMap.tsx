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

type MapPoint = { x: number; y: number; source: 'manual' | 'telemetry' | 'schematic' }

const schematicSlots: Record<RegionKey, Array<{ x: number; y: number }>> = {
  latium: [
    { x: .20, y: .30 }, { x: .42, y: .25 }, { x: .66, y: .31 }, { x: .31, y: .58 },
    { x: .57, y: .58 }, { x: .80, y: .56 }, { x: .18, y: .75 }, { x: .46, y: .78 },
    { x: .72, y: .78 }, { x: .88, y: .30 },
  ],
  albion: [
    { x: .22, y: .28 }, { x: .47, y: .31 }, { x: .73, y: .27 }, { x: .30, y: .60 },
    { x: .58, y: .62 }, { x: .80, y: .61 }, { x: .17, y: .78 }, { x: .45, y: .81 },
    { x: .72, y: .80 }, { x: .89, y: .43 },
  ],
}

function normalizePositions(areas: Area[], region: RegionKey): Map<number, MapPoint> {
  const observed = areas.filter((item) => item.position && item.position_source === 'telemetry')
  const xs = observed.map((item) => item.position!.x)
  const ys = observed.map((item) => item.position!.y)
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 1)
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 1)
  const sorted = [...areas].sort((a, b) => a.name.localeCompare(b.name) || a.area_pk - b.area_pk)
  return new Map(sorted.map((area, index): [number, MapPoint] => {
    if (!area.position) {
      const slot = schematicSlots[region][index % schematicSlots[region].length]
      const round = Math.floor(index / schematicSlots[region].length)
      return [area.area_pk, {
        x: Math.min(.92, slot.x + round * .018),
        y: Math.min(.88, slot.y + round * .018),
        source: 'schematic',
      }]
    }
    if (area.position_source === 'manual') return [area.area_pk, { ...area.position, source: 'manual' }]
    const x = maxX === minX ? .25 + (index % 4) * .16 : .1 + ((area.position.x - minX) / (maxX - minX)) * .8
    const y = maxY === minY ? .3 + (Math.floor(index / 4) % 3) * .2 : .12 + ((area.position.y - minY) / (maxY - minY)) * .76
    return [area.area_pk, { x, y, source: 'telemetry' }]
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
  const positioned = useMemo(() => normalizePositions(areas, region), [areas, region])
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
    <header><div><strong>{region === 'latium' ? 'Latium' : 'Albion'}</strong><small>{areas.length} persisted cities{unplaced.length ? ` · ${unplaced.length} schematic` : ''}</small></div>{editable ? <span><Move size={13} /> Drag or place cities</span> : unplaced.length > 0 ? <span>Schematic placement</span> : null}</header>
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
        <path className="map-land" d="M35 106c30-54 93-79 148-58 30 12 48 40 75 57 25 16 63 18 81 44 18 27 5 66-19 87-29 26-72 30-103 53-24 18-39 52-70 58-45 9-94-24-105-68-8-33 13-62 11-94-1-29-33-50-18-79Z" />
        <path className="map-land secondary" d="M326 45c51-26 118-17 155 27 25 29 34 72 68 91 39 22 94 2 129 32 35 30 26 87-8 116-30 25-74 25-109 12-38-13-72-36-113-35-42 1-86 25-124 7-38-18-51-70-29-104 17-27 54-39 66-69 10-27-6-55-35-77Z" />
        <path className="map-land islet" d="M610 64c25-19 66-14 81 14 12 22 3 48-18 60-23 13-57 8-70-16-10-20-10-44 7-58ZM684 342c24-13 57-4 68 20 8 18-2 39-22 45-24 7-54-5-58-27-3-15 0-30 12-38ZM212 370c21-12 50-4 60 17 6 14-3 30-19 36-22 8-49-2-54-21-3-12 2-25 13-32Z" />
        <path className="map-road" d="M69 193c72-63 167-30 237-8M125 90c45 65 42 140 8 214M369 100c73 36 87 117 151 166m31-57c50-11 90 12 126 67" />
      </> : <>
        <path className="map-water" d="M0 0h800v430H0z" />
        <path className="map-land" d="M59 125c24-66 95-103 158-82 36 12 59 46 96 55 35 8 70-13 106-9 45 6 79 49 76 94-4 52-52 82-92 110-44 31-80 78-134 82-54 5-106-40-117-92-8-38 12-74 4-111-9-38-47-69-97-47Z" />
        <path className="map-land secondary" d="M452 42c46-25 108-12 135 32 19 31 16 72 42 98 25 25 68 25 90 53 28 36 8 90-31 111-34 19-76 8-108-11-35-21-65-55-106-59-38-4-77 18-111 0-31-17-44-60-25-90 19-29 61-38 78-68 12-21 12-50 36-66Z" />
        <path className="map-land islet" d="M646 75c20-17 53-13 67 9 12 20 4 45-16 57-22 12-52 6-62-16-8-18-4-38 11-50ZM65 341c23-15 56-7 69 17 10 19 0 42-21 51-25 10-56-2-65-26-6-16 3-32 17-42ZM612 355c24-16 60-8 72 18 9 20-3 43-25 50-27 8-59-7-64-31-4-15 3-29 17-37Z" />
        <path className="map-marsh" d="M83 250c73-49 139-27 202 23s127 26 183-19M120 111c75 24 102 85 105 157M468 90c-8 62 12 112 71 151m47-30c47-9 91 13 124 48" />
      </>}
      {areas.map((area) => {
        const point = positioned.get(area.area_pk)
        if (!point) return null
        const x = point.x * 800, y = point.y * 430
        const severity = severityFor(area.area_pk, signals)
        const labelOnLeft = point.x > .72
        return <g key={area.area_pk} className={`city-marker ${severity} ${point.source}`} transform={`translate(${x} ${y})`} role="link" tabIndex={0} aria-label={`${area.name}, ${severity}, ${point.source} position`} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(`/areas/${area.area_pk}`) }} onClick={(event) => { event.stopPropagation(); if (!editable) navigate(`/areas/${area.area_pk}`) }} onPointerDown={(event) => { if (editable) { event.stopPropagation(); setDragging(area.area_pk); event.currentTarget.setPointerCapture(event.pointerId) } }}>
          <circle className="marker-glow" r="20" />
          <circle className="marker-core" r="10" />
          {severity !== 'stable' && <AlertTriangle x={-6} y={-6} width={12} height={12} />}
          <text x={labelOnLeft ? -15 : 15} y="4" textAnchor={labelOnLeft ? 'end' : 'start'}>{area.name}</text>
        </g>
      })}
    </svg>
    {editable && unplaced.length > 0 && <div className="unplaced-strip"><MapPin size={14} /><span>Place:</span>{unplaced.map((area) => <button className={placing === area.area_pk ? 'active' : ''} key={area.area_pk} onClick={() => setPlacing(area.area_pk)}>{area.name}</button>)}</div>}
  </section>
}
