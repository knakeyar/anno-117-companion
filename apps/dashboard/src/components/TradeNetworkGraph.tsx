import { useCallback, useEffect, useMemo, useState } from 'react'
import dagre from '@dagrejs/dagre'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getBezierPath,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, ArrowRight, Boxes, CircleHelp, Copy, ExternalLink, List, Network, PackageOpen, Route, Ship, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { TradeNetworkEdge, TradeNetworkGraph as TradeGraph, TradeNetworkNode, TradeNetworkResponse, TradePlan } from '../types'
import { formatNumber, titleCase } from '../utils'

type GraphKey = 'latium' | 'albion' | 'cross_region'
type LayoutMode = 'force' | 'flow' | 'circle'
type CityNodeData = TradeNetworkNode & Record<string, unknown>
type CityFlowNode = Node<CityNodeData, 'city'>
type TradeEdgeData = { evidence: TradeNetworkEdge; parallel: boolean; layout: LayoutMode }
type TradeFlowEdge = Edge<TradeEdgeData, 'trade'>

const nodeWidth = 240
const nodeHeight = 128

function CityPortMark({ region, severity, name }: { region: TradeNetworkNode['region']; severity: TradeNetworkNode['severity']; name: string }) {
  return <span className={`city-port-mark ${region ?? 'unknown'} ${severity}`} aria-hidden="true"><svg viewBox="0 0 64 64">
    <path className="port-water" d="M5 47c8-4 13 4 21 0s14-4 22 0 9 1 12-1v9H5z" />
    <path className="port-island" d={region === 'albion' ? 'M8 43c4-15 15-24 29-23 10 1 17 8 20 20-10 3-18 4-26 1-7-2-14-1-23 2z' : 'M7 43c7-12 15-20 28-21 11-1 18 5 22 18-9 5-18 5-27 2-7-2-14-1-23 1z'} />
    <path className="port-roofs" d="M17 34l7-6 7 6v8H17zm18 2 6-9 7 9v6H35z" />
    <path className="port-tower" d="M48 22h5v20h-5zm-2 0 4-7 5 7z" />
    <path className="port-wave" d="M8 50c6-3 11 3 17 0s11-3 17 0 10 2 15-1" />
    <text x="24" y="40">{name.trim().slice(0, 1).toUpperCase()}</text>
  </svg></span>
}

function CityNode({ data, selected }: NodeProps<CityFlowNode>) {
  const fill = data.stock_health.average_fill_ratio
  return <article className={`network-city-node ${data.severity} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <header className="network-city-header"><CityPortMark region={data.region} severity={data.severity} name={data.area_name} /><span className="network-city-title"><small>{data.region === 'latium' ? 'Latium port' : data.region === 'albion' ? 'Albion port' : 'Unplaced port'}</small><strong>{data.area_name}</strong></span><em>{data.severity}</em></header>
    <div className="network-city-stats"><span><b>{data.pressure_count}</b><small>pressures</small></span><span><b>{data.route_issue_count}</b><small>route issues</small></span><span><b>{data.running_route_count}/{data.paused_route_count}/{data.planned_route_count}</b><small>run/pause/plan</small></span></div>
    <div className="network-stock-track" aria-label={fill == null ? 'Stock health unavailable' : `Average tracked stock ${Math.round(fill * 100)} percent full`}><i style={{ width: `${Math.max(0, Math.min(100, (fill ?? 0) * 100))}%` }} /></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </article>
}

function TradeEdge(props: EdgeProps<TradeFlowEdge>) {
  const evidence = props.data?.evidence
  const pathResult = props.data?.layout === 'flow' ? getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 18,
    offset: props.data?.parallel ? 34 : 24,
  }) : getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: props.data?.parallel ? .42 : .24,
  })
  const [path, labelX, labelY] = pathResult
  if (!evidence) return null
  return <>
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      interactionWidth={24}
      className={`network-edge-path ${evidence.status} severity-${evidence.severity} ${evidence.freshness} goods-${evidence.goods_verification}`}
    />
    <EdgeLabelRenderer><button
      className={`network-edge-label nodrag nopan ${evidence.status} severity-${evidence.severity} ${evidence.freshness} goods-${evidence.goods_verification}`}
      style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
      aria-label={`${evidence.source_area_name} to ${evidence.destination_area_name}: ${evidence.summary.goods} goods, ${evidence.summary.routes} routes, ${evidence.summary.ships} ships`}
      onClick={(event) => {
        event.stopPropagation()
        window.dispatchEvent(new CustomEvent('anno:trade-edge', { detail: evidence.edge_id }))
      }}
    >{evidence.summary.goods} goods · {evidence.summary.routes} routes · {evidence.summary.ships} ships</button></EdgeLabelRenderer>
  </>
}

const nodeTypes = { city: CityNode }
const edgeTypes = { trade: TradeEdge }

function flowLayout(graph: TradeGraph, graphKey: GraphKey): CityFlowNode[] {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: 'LR', nodesep: 34, ranksep: graphKey === 'cross_region' ? 180 : 95, marginx: 25, marginy: 25 })
  for (const node of graph.nodes) layout.setNode(node.node_id, { width: nodeWidth, height: nodeHeight })
  for (const edge of graph.edges) layout.setEdge(`area-${edge.source_area_pk}`, `area-${edge.destination_area_pk}`)
  dagre.layout(layout)
  const crossOrder = [...graph.nodes].sort((left, right) => {
    const leftRank = left.region === 'latium' ? 0 : 1
    const rightRank = right.region === 'latium' ? 0 : 1
    return leftRank - rightRank || (layout.node(left.node_id)?.y ?? 0) - (layout.node(right.node_id)?.y ?? 0) || left.area_name.localeCompare(right.area_name)
  })
  const regionIndexes = { latium: 0, albion: 0 }
  return (graphKey === 'cross_region' ? crossOrder : graph.nodes).map((node) => {
    const point = layout.node(node.node_id) ?? { x: 0, y: 0 }
    let x = point.x - nodeWidth / 2
    let y = point.y - nodeHeight / 2
    if (graphKey === 'cross_region') {
      const region = node.region === 'albion' ? 'albion' : 'latium'
      x = region === 'latium' ? 25 : 430
      y = 25 + regionIndexes[region] * (nodeHeight + 42)
      regionIndexes[region] += 1
    }
    return {
      id: node.node_id,
      type: 'city',
      position: { x, y },
      data: { ...node },
      ariaLabel: `${node.area_name}, ${node.severity}, ${node.pressure_count} economic pressures`,
    }
  })
}

function circleLayout(graph: TradeGraph, graphKey: GraphKey): CityFlowNode[] {
  const degree = new Map(graph.nodes.map((node) => [node.node_id, 0]))
  for (const edge of graph.edges) {
    degree.set(`area-${edge.source_area_pk}`, (degree.get(`area-${edge.source_area_pk}`) ?? 0) + 1)
    degree.set(`area-${edge.destination_area_pk}`, (degree.get(`area-${edge.destination_area_pk}`) ?? 0) + 1)
  }
  const ordered = [...graph.nodes].sort((left, right) => {
    if (graphKey === 'cross_region' && left.region !== right.region) return left.region === 'latium' ? -1 : 1
    return (degree.get(right.node_id) ?? 0) - (degree.get(left.node_id) ?? 0) || left.area_name.localeCompare(right.area_name)
  })
  const radius = Math.max(330, ordered.length * 48)
  const centerX = radius + nodeWidth / 2 + 60
  const centerY = radius * .72 + nodeHeight / 2 + 60
  return ordered.map((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, ordered.length)
    return toFlowNode(node, {
      x: centerX + Math.cos(angle) * radius - nodeWidth / 2,
      y: centerY + Math.sin(angle) * radius * .68 - nodeHeight / 2,
    })
  })
}

function toFlowNode(node: TradeNetworkNode, position: { x: number; y: number }): CityFlowNode {
  return {
    id: node.node_id,
    type: 'city',
    position,
    data: { ...node },
    ariaLabel: `${node.area_name}, ${node.severity}, ${node.pressure_count} economic pressures`,
  }
}

function forceLayout(graph: TradeGraph, graphKey: GraphKey): CityFlowNode[] {
  const ordered = [...graph.nodes].sort((left, right) => left.area_name.localeCompare(right.area_name))
  if (ordered.length <= 1) return ordered.map((node) => toFlowNode(node, { x: 80, y: 80 }))
  const width = Math.max(1100, Math.ceil(Math.sqrt(ordered.length)) * 360)
  const height = Math.max(680, Math.ceil(ordered.length / 4) * 230)
  const centerX = width / 2
  const centerY = height / 2
  const indexById = new Map(ordered.map((node, index) => [node.node_id, index]))
  const degree = ordered.map(() => 0)
  const connections = graph.edges.flatMap((edge) => {
    const source = indexById.get(`area-${edge.source_area_pk}`)
    const destination = indexById.get(`area-${edge.destination_area_pk}`)
    if (source == null || destination == null) return []
    degree[source] += 1
    degree[destination] += 1
    return [[source, destination] as const]
  })
  const maxDegree = Math.max(1, ...degree)
  const state = ordered.map((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / ordered.length
    const radius = Math.min(width, height) * (degree[index] ? .34 : .43)
    return { node, x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius, vx: 0, vy: 0 }
  })
  for (let iteration = 0; iteration < 280; iteration += 1) {
    const forces = state.map(() => ({ x: 0, y: 0 }))
    for (let left = 0; left < state.length; left += 1) {
      for (let right = left + 1; right < state.length; right += 1) {
        let dx = state[right].x - state[left].x
        let dy = state[right].y - state[left].y
        if (Math.abs(dx) + Math.abs(dy) < .01) { dx = right % 2 ? 1 : -1; dy = .5 }
        const distanceSquared = Math.max(900, dx * dx + dy * dy)
        const distance = Math.sqrt(distanceSquared)
        const repulsion = 120000 / distanceSquared
        const fx = (dx / distance) * repulsion
        const fy = (dy / distance) * repulsion
        forces[left].x -= fx; forces[left].y -= fy
        forces[right].x += fx; forces[right].y += fy
      }
    }
    for (const [source, destination] of connections) {
      const dx = state[destination].x - state[source].x
      const dy = state[destination].y - state[source].y
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const attraction = (distance - 330) * .012
      const fx = (dx / distance) * attraction
      const fy = (dy / distance) * attraction
      forces[source].x += fx; forces[source].y += fy
      forces[destination].x -= fx; forces[destination].y -= fy
    }
    for (let index = 0; index < state.length; index += 1) {
      const centrality = 1 + (degree[index] / maxDegree) * 1.6
      forces[index].x += (centerX - state[index].x) * .0025 * centrality
      forces[index].y += (centerY - state[index].y) * .0025 * centrality
      if (graphKey === 'cross_region') {
        const targetX = state[index].node.region === 'latium' ? width * .28 : width * .72
        forces[index].x += (targetX - state[index].x) * .018
      }
      state[index].vx = (state[index].vx + forces[index].x * .5) * .78
      state[index].vy = (state[index].vy + forces[index].y * .5) * .78
      const speed = Math.max(1, Math.sqrt(state[index].vx ** 2 + state[index].vy ** 2) / 13)
      state[index].x = Math.max(nodeWidth / 2 + 35, Math.min(width - nodeWidth / 2 - 35, state[index].x + state[index].vx / speed))
      state[index].y = Math.max(nodeHeight / 2 + 35, Math.min(height - nodeHeight / 2 - 35, state[index].y + state[index].vy / speed))
    }
    for (let left = 0; left < state.length; left += 1) {
      for (let right = left + 1; right < state.length; right += 1) {
        const dx = state[right].x - state[left].x
        const dy = state[right].y - state[left].y
        const overlapX = nodeWidth + 54 - Math.abs(dx)
        const overlapY = nodeHeight + 54 - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        if (overlapX < overlapY) {
          const shift = overlapX / 2 + 1
          state[left].x -= dx >= 0 ? shift : -shift
          state[right].x += dx >= 0 ? shift : -shift
        } else {
          const shift = overlapY / 2 + 1
          state[left].y -= dy >= 0 ? shift : -shift
          state[right].y += dy >= 0 ? shift : -shift
        }
      }
    }
  }
  return state.map(({ node, x, y }) => toFlowNode(node, { x: x - nodeWidth / 2, y: y - nodeHeight / 2 }))
}

export function calculateTradeLayout(graph: TradeGraph, graphKey: GraphKey, mode: LayoutMode): CityFlowNode[] {
  if (mode === 'flow') return flowLayout(graph, graphKey)
  if (mode === 'circle') return circleLayout(graph, graphKey)
  return forceLayout(graph, graphKey)
}

function layoutStorageKey(campaignId: string | null, graphKey: GraphKey) {
  return `anno-companion:trade-network:${campaignId ?? 'none'}:${graphKey}:layout:v2`
}

function preferredLayout(key: string): LayoutMode {
  const value = localStorage.getItem(key)
  return value === 'flow' || value === 'circle' ? value : 'force'
}

function NetworkCanvas({ campaignId, graphKey, graph, onEdge, onNode }: {
  campaignId: string | null
  graphKey: GraphKey
  graph: TradeGraph
  onEdge: (edge: TradeNetworkEdge) => void
  onNode: (node: TradeNetworkNode) => void
}) {
  const preferenceKey = layoutStorageKey(campaignId, graphKey)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => preferredLayout(preferenceKey))
  const calculated = useMemo(() => calculateTradeLayout(graph, graphKey, layoutMode), [graph, graphKey, layoutMode])
  const [nodes, setNodes] = useState<CityFlowNode[]>([])
  const [instance, setInstance] = useState<ReactFlowInstance<CityFlowNode, TradeFlowEdge> | null>(null)
  useEffect(() => {
    setNodes(calculated)
    const timer = window.setTimeout(() => instance?.fitView({ padding: .15, duration: 300 }), 0)
    return () => window.clearTimeout(timer)
  }, [calculated, instance])
  const directedPairs = useMemo(() => new Set(graph.edges.map((edge) => `${edge.source_area_pk}:${edge.destination_area_pk}`)), [graph.edges])
  const edges = useMemo<TradeFlowEdge[]>(() => graph.edges.map((edge) => ({
    id: edge.edge_id,
    source: `area-${edge.source_area_pk}`,
    target: `area-${edge.destination_area_pk}`,
    type: 'trade',
    data: { evidence: edge, parallel: directedPairs.has(`${edge.destination_area_pk}:${edge.source_area_pk}`), layout: layoutMode },
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    animated: edge.status === 'running' && edge.freshness === 'live' && edge.goods_verification !== 'unavailable',
    ariaLabel: `${edge.source_area_name} to ${edge.destination_area_name}, ${edge.summary.goods} goods, ${edge.status}`,
  })), [directedPairs, graph.edges, layoutMode])
  const onNodesChange = useCallback((changes: NodeChange<CityFlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), [])
  const chooseLayout = (mode: LayoutMode) => {
    localStorage.setItem(preferenceKey, mode)
    setLayoutMode(mode)
  }
  const autoSort = () => {
    setNodes(calculateTradeLayout(graph, graphKey, layoutMode))
    window.setTimeout(() => instance?.fitView({ padding: .15, duration: 300 }), 0)
  }
  return <div className="trade-network-canvas">
    <div className="network-layout-picker" role="group" aria-label="Graph layout">{(['force', 'flow', 'circle'] as LayoutMode[]).map((mode) => <button aria-pressed={layoutMode === mode} className={layoutMode === mode ? 'active' : ''} key={mode} onClick={() => chooseLayout(mode)}>{titleCase(mode)}</button>)}</div>
    <div className="network-canvas-tools"><button onClick={() => instance?.fitView({ padding: .15, duration: 250 })}>Fit</button><button onClick={autoSort}>Auto-sort</button></div>
    <ReactFlow<CityFlowNode, TradeFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onInit={setInstance}
      onNodesChange={onNodesChange}
      onNodeClick={(_event, node) => onNode(node.data)}
      onEdgeClick={(_event, edge) => edge.data && onEdge(edge.data.evidence)}
      nodesConnectable={false}
      edgesReconnectable={false}
      deleteKeyCode={null}
      fitView
      fitViewOptions={{ padding: .15 }}
      minZoom={.35}
      maxZoom={1.5}
      colorMode="dark"
      ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter to select this city.', 'edge.a11yDescription.default': 'Press Enter to inspect this trade relationship.' }}
    ><Background color="#294044" gap={24} size={1} /><Controls showInteractive={false} /></ReactFlow>
  </div>
}

function EvidenceDrawer({ edge, node, allEdges, onClose, onUnlink }: { edge: TradeNetworkEdge | null; node: TradeNetworkNode | null; allEdges: TradeNetworkEdge[]; onClose: () => void; onUnlink: (linkId: string) => void }) {
  if (!edge && !node) return null
  const connected = node ? allEdges.filter((item) => item.source_area_pk === node.area_pk || item.destination_area_pk === node.area_pk) : []
  return <div className="drawer-backdrop" role="presentation" onClick={onClose}><aside className="network-evidence-drawer" role="dialog" aria-modal="true" aria-label={edge ? `Trade evidence for ${edge.source_area_name} to ${edge.destination_area_name}` : `City evidence for ${node!.area_name}`} onClick={(event) => event.stopPropagation()}>
    <button className="icon-button drawer-close" aria-label="Close evidence" onClick={onClose}><X size={16} /></button>
    {edge ? <>
      <span className={`route-status ${edge.status}`}>{titleCase(edge.status)} · {edge.freshness}</span>
      <h2>{edge.source_area_name} <ArrowRight size={18} /> {edge.destination_area_name}</h2>
      <p className="drawer-notice">Endpoints come from {edge.endpoint_evidence.map((item) => item.kind.replaceAll('_', ' ')).join(', ')} evidence. Planned goods are not proof of in-game configuration or cargo.</p>
      {edge.endpoint_evidence.some((item) => item.kind === 'manual' && item.link_id) && <div className="drawer-link-controls">{edge.endpoint_evidence.filter((item) => item.kind === 'manual' && item.link_id).map((item) => <button className="button ghost" key={item.link_id} onClick={() => { if (item.link_id) onUnlink(item.link_id); onClose() }}><X size={13} /> Remove manual link</button>)}<small>Removing it returns the observed route to the unmapped tray, where you can link it again with corrected endpoints.</small></div>}
      <section><h3>Planned goods</h3>{edge.planned_goods.length ? <div className="drawer-goods">{edge.planned_goods.map((good, index) => <span key={`${good.trade_plan_id}-${good.product_guid}-${index}`}><PackageOpen size={14} /><b>{good.product_name ?? good.product_guid}</b><em>{formatNumber(good.amount)} target</em><small>Planned</small></span>)}</div> : <p>No companion goods plan is linked.</p>}</section>
      <section><h3>Goods named on the route</h3>{edge.route_name_goods.length ? <div className="drawer-goods">{edge.route_name_goods.map((good) => <span key={`route-name-${good.product_guid}`}><Route size={14} /><b>{good.product_name ?? good.product_guid}</b><em>Amount unknown</em><small>Read from route name</small></span>)}</div> : <p>No catalog good could be matched exactly from the route name.</p>}<p>Route-name labels make the graph useful, but do not prove Anno’s configured loading slots or current ship cargo.</p></section>
      <section><h3>Configured goods</h3>{edge.configured_goods.length ? <div className="drawer-goods">{edge.configured_goods.map((good, index) => <span key={`configured-${index}`}><PackageOpen size={14} /><b>{String(good.product_name ?? good.product_guid)}</b><em>{good.amount == null ? 'amount unknown' : formatNumber(Number(good.amount))}</em><small>Configured in Anno</small></span>)}</div> : <p>Not exposed by validated telemetry.</p>}</section>
      <section><h3>Cargo aboard</h3>{edge.cargo_aboard.length ? <div className="drawer-goods">{edge.cargo_aboard.map((good, index) => <span key={`cargo-${index}`}><Ship size={14} /><b>{String(good.product_name ?? good.product_guid)}</b><em>{good.amount == null ? 'amount unknown' : formatNumber(Number(good.amount))}</em><small>Observed aboard ship {String(good.ship_id ?? 'unknown')}</small></span>)}</div> : <p>Unavailable: the tested ship cargo binding returned invalid weak references.</p>}</section>
      <section><h3>Anno routes and ships</h3>{edge.routes.length ? edge.routes.map((route) => <article className="drawer-route" key={route.route_key}><header><Route size={15} /><strong>{route.route_name}</strong><em>{titleCase(route.status)} · {edge.freshness}</em></header>{route.issues.map((issue) => <p className="negative" key={issue.issue_code}><AlertTriangle size={12} />{issue.label}. {issue.guidance}</p>)}<div>{route.ships.map((ship) => <span key={ship.ship_id}><Ship size={13} /><b>{ship.ship_name || `Ship ${ship.ship_id}`}</b><small>{ship.is_paused ? 'Paused' : 'Running'} · ID {ship.ship_id} · type {ship.ship_guid ?? 'unknown'} · last area {ship.area_id ?? 'unknown'} · session {ship.game_session_guid ?? 'unknown'}</small></span>)}</div></article>) : <p>No tagged or manually linked Anno route has been detected.</p>}</section>
      <section><h3>Companion plans</h3>{edge.plans.length ? edge.plans.map((plan) => <article className="drawer-plan" key={plan.trade_plan_id}><header><strong>{plan.route_tag}</strong><button className="icon-button" aria-label={`Copy route name ${plan.suggested_route_name}`} onClick={() => plan.suggested_route_name && navigator.clipboard?.writeText(plan.suggested_route_name)}><Copy size={13} /></button></header><p>{plan.suggested_route_name}</p><small>{plan.plan_kind.replaceAll('_', ' ')} · {plan.workflow_status} · {plan.runtime_status}</small></article>) : <p>No companion plan is associated with this observed relationship.</p>}</section>
      <section><h3>Recommended follow-up</h3>{edge.actions.length ? edge.actions.map((action, index) => <article className="drawer-plan" key={String(action.action_id ?? index)}><strong>{String(action.title ?? 'Review this route')}</strong><p>{String(action.summary ?? '')}</p></article>) : <p>No additional deterministic action is attached to this relationship.</p>}</section>
    </> : <>
      <span className={`route-status ${node!.severity}`}>{node!.region ?? 'Unknown region'}</span><h2>{node!.area_name}</h2>
      <div className="network-node-summary"><span><b>{node!.pressure_count}</b><small>pressures</small></span><span><b>{node!.running_route_count}</b><small>running routes</small></span><span><b>{node!.planned_route_count}</b><small>planned routes</small></span></div>
      <section><h3>Connected relationships</h3>{connected.length ? connected.map((item) => <button className="drawer-edge-link" key={item.edge_id} onClick={() => window.dispatchEvent(new CustomEvent('anno:trade-edge', { detail: item.edge_id }))}>{item.source_area_name} <ArrowRight size={12} /> {item.destination_area_name}<small>{titleCase(item.status)}</small></button>) : <p>No mapped relationships yet.</p>}</section>
      <section><h3>Important goods</h3>{node!.important_goods.length ? <div className="drawer-goods">{node!.important_goods.map((good) => <span key={good.product_guid}><PackageOpen size={14} /><b>{good.product_name}</b><em>{formatNumber(good.stock)} / {formatNumber(good.capacity)}</em><small>{good.net_stock_change_per_minute == null ? 'Net stock change unavailable' : `${good.net_stock_change_per_minute >= 0 ? '+' : ''}${formatNumber(good.net_stock_change_per_minute)}/min net stock change`}</small></span>)}</div> : <p>No current inventory evidence is available.</p>}</section>
      <section><h3>Pressure signals</h3>{node!.pressure_signals.length ? node!.pressure_signals.map((signal) => <article className="drawer-plan" key={`${signal.code}-${signal.product_guid}`}><strong>{signal.product_name}</strong><p>{signal.label}</p><small>{titleCase(signal.severity)} · inferred pressure</small></article>) : <p>No current stock-derived pressure signals.</p>}</section>
      <Link className="button primary" to={`/areas/${node!.area_pk}`}>Open city detail <ExternalLink size={13} /></Link>
    </>}
  </aside></div>
}

function UnmappedRoutes({ network, plans, onLink, onRelink }: { network: TradeNetworkResponse; plans: TradePlan[]; onLink: (body: { campaign_id: string; route_key: string; source_area_pk: number; destination_area_pk: number; trade_plan_id?: string }) => void; onRelink: (linkId: string, routeKey: string) => void }) {
  const [routeKey, setRouteKey] = useState<string | null>(null)
  const [planId, setPlanId] = useState('')
  if (!network.unmapped_routes.length) return null
  const availablePlans = plans.filter((plan) => !['completed', 'dismissed'].includes(plan.status))
  return <details className="panel unmapped-route-tray"><summary><div><strong>Routes needing attention</strong><small>Exact city aliases auto-resolve. These names are ambiguous, incomplete, or do not follow the “Good SRC - DST” convention.</small></div><span>{network.unmapped_routes.length}</span></summary><div className="unmapped-route-grid">{network.unmapped_routes.map((route) => <article key={route.route_key}><span className="product-glyph"><Ship size={16} /></span><div><strong>{route.route_name}</strong><p>{route.ships.map((ship) => ship.ship_name || `Ship ${ship.ship_id}`).join(' · ') || 'No assigned ship evidence'}</p><small>{titleCase(route.status)} · {titleCase(route.freshness ?? (route.is_stale ? 'stale' : 'live'))} · endpoint evidence unavailable</small>{route.relink_suggestions?.map((suggestion) => <div className="relink-suggestion" key={suggestion.link_id}><span>Possible rename of <b>{suggestion.previous_route_name}</b> ({suggestion.overlapping_ship_ids.length} matching ship ID{suggestion.overlapping_ship_ids.length === 1 ? '' : 's'}).</span><button className="button ghost" onClick={() => onRelink(suggestion.link_id, route.route_key)}>Confirm relink</button></div>)}{routeKey === route.route_key && <div className="route-link-form plan-only"><label>Saved companion plan<select value={planId} onChange={(event) => setPlanId(event.target.value)}><option value="">Choose the plan this route implements</option>{availablePlans.map((plan) => <option value={plan.trade_plan_id} key={plan.trade_plan_id}>{plan.route_tag} · {plan.source_area_name} to {plan.destination_area_name}</option>)}</select></label><button className="button primary" disabled={!planId || !network.campaign_id} onClick={() => {
            const plan = availablePlans.find((item) => item.trade_plan_id === planId)
            if (network.campaign_id && plan) onLink({ campaign_id: network.campaign_id, route_key: route.route_key, source_area_pk: plan.source_area_pk, destination_area_pk: plan.destination_area_pk, trade_plan_id: plan.trade_plan_id })
          }}>Associate plan</button></div>}</div><button className="button ghost" disabled={!availablePlans.length} onClick={() => {
          const next = routeKey === route.route_key ? null : route.route_key
          setRouteKey(next)
          if (next) setPlanId('')
        }}>{routeKey === route.route_key ? <X size={13} /> : <Boxes size={13} />}{routeKey === route.route_key ? 'Cancel' : 'Match a saved plan'}</button></article>)}</div></details>
}

interface TradeNetworkProps {
  network: TradeNetworkResponse
  plans: TradePlan[]
  onLink: (body: { campaign_id: string; route_key: string; source_area_pk: number; destination_area_pk: number; trade_plan_id?: string }) => void
  onUnlink: (linkId: string) => void
  onRelink: (linkId: string, routeKey: string) => void
  showUnmapped?: boolean
}

export function TradeNetworkExplorer(props: TradeNetworkProps) {
  const [tab, setTab] = useState<GraphKey>('latium')
  const [listView, setListView] = useState(false)
  const [selectedEdge, setSelectedEdge] = useState<TradeNetworkEdge | null>(null)
  const [selectedNode, setSelectedNode] = useState<TradeNetworkNode | null>(null)
  const graph = props.network.graphs[tab]
  const allEdges = useMemo(() => Object.values(props.network.graphs).flatMap((item) => item.edges), [props.network.graphs])
  useEffect(() => {
    const listener = (event: Event) => {
      const edgeId = (event as CustomEvent<string>).detail
      const found = allEdges.find((edge) => edge.edge_id === edgeId)
      if (found) { setSelectedNode(null); setSelectedEdge(found) }
    }
    window.addEventListener('anno:trade-edge', listener)
    return () => window.removeEventListener('anno:trade-edge', listener)
  }, [allEdges])
  return <>
    <section className="trade-network-explorer" aria-label="Trade network"><header><div><strong>Trade network</strong><small>Auto-sorted relationships. Select a layout, then inspect an edge for ships and resource evidence.</small></div><div className="network-view-controls"><nav aria-label="Trade network region">{(['latium', 'albion', 'cross_region'] as GraphKey[]).map((item) => <button className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item === 'cross_region' ? 'Cross-region' : titleCase(item)}</button>)}</nav><button className="button ghost" onClick={() => setListView((value) => !value)}>{listView ? <Network size={13} /> : <List size={13} />}{listView ? 'Graph' : 'List'}</button></div></header>{listView ? <div className="network-list-view">{graph.edges.length ? graph.edges.map((edge) => <button key={edge.edge_id} onClick={() => { setSelectedNode(null); setSelectedEdge(edge) }}><span><strong>{edge.source_area_name}</strong><ArrowRight size={13} /><strong>{edge.destination_area_name}</strong></span><small>{edge.summary.goods} goods · {edge.summary.routes} routes · {edge.summary.ships} ships · {titleCase(edge.status)}</small></button>) : <p>No mapped trade relationships in this view.</p>}</div> : graph.nodes.length ? <ReactFlowProvider><NetworkCanvas campaignId={props.network.campaign_id} graphKey={tab} graph={graph} onEdge={(edge) => { setSelectedNode(null); setSelectedEdge(edge) }} onNode={(node) => { setSelectedEdge(null); setSelectedNode(node) }} /></ReactFlowProvider> : <div className="network-empty"><Network size={24} /><strong>No cities in this view yet</strong><span>Persisted cities appear here as telemetry identifies their region.</span></div>}</section>
    {(props.showUnmapped ?? true) && <UnmappedRoutes network={props.network} plans={props.plans} onLink={props.onLink} onRelink={props.onRelink} />}
    <div className="network-evidence-notice"><CircleHelp size={14} />{props.network.evidence_notice}</div>
    <EvidenceDrawer edge={selectedEdge} node={selectedNode} allEdges={allEdges} onUnlink={props.onUnlink} onClose={() => { setSelectedEdge(null); setSelectedNode(null) }} />
  </>
}
