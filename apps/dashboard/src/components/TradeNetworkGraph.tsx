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
import type { Area, TradeNetworkEdge, TradeNetworkGraph as TradeGraph, TradeNetworkNode, TradeNetworkResponse, TradePlan } from '../types'
import { formatNumber, titleCase } from '../utils'

type GraphKey = 'latium' | 'albion' | 'cross_region'
type CityNodeData = TradeNetworkNode & Record<string, unknown>
type CityFlowNode = Node<CityNodeData, 'city'>
type TradeEdgeData = { evidence: TradeNetworkEdge; parallel: boolean }
type TradeFlowEdge = Edge<TradeEdgeData, 'trade'>

const nodeWidth = 190
const nodeHeight = 92

function CityNode({ data, selected }: NodeProps<CityFlowNode>) {
  const fill = data.stock_health.average_fill_ratio
  return <article className={`network-city-node ${data.severity} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <header><span>{data.region === 'latium' ? 'LAT' : data.region === 'albion' ? 'ALB' : '?'}</span><strong>{data.area_name}</strong></header>
    <div className="network-city-stats"><span><b>{data.pressure_count}</b><small>pressures</small></span><span><b>{data.route_issue_count}</b><small>route issues</small></span><span><b>{data.running_route_count}/{data.paused_route_count}/{data.planned_route_count}</b><small>run/pause/plan</small></span></div>
    <div className="network-stock-track" aria-label={fill == null ? 'Stock health unavailable' : `Average tracked stock ${Math.round(fill * 100)} percent full`}><i style={{ width: `${Math.max(0, Math.min(100, (fill ?? 0) * 100))}%` }} /></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </article>
}

function TradeEdge(props: EdgeProps<TradeFlowEdge>) {
  const evidence = props.data?.evidence
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: props.data?.parallel ? .42 : .24,
  })
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

function layoutGraph(graph: TradeGraph, graphKey: GraphKey): CityFlowNode[] {
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
      y = 25 + regionIndexes[region] * 125
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

function storageKey(campaignId: string | null, graphKey: GraphKey) {
  return `anno-companion:trade-network:${campaignId ?? 'none'}:${graphKey}:v1`
}

function loadSavedPositions(key: string): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, { x: number; y: number }> } catch { return {} }
}

function NetworkCanvas({ campaignId, graphKey, graph, compact, onEdge, onNode }: {
  campaignId: string | null
  graphKey: GraphKey
  graph: TradeGraph
  compact?: boolean
  onEdge: (edge: TradeNetworkEdge) => void
  onNode: (node: TradeNetworkNode) => void
}) {
  const key = storageKey(campaignId, graphKey)
  const calculated = useMemo(() => layoutGraph(graph, graphKey), [graph, graphKey])
  const [layoutRevision, setLayoutRevision] = useState(0)
  const [nodes, setNodes] = useState<CityFlowNode[]>([])
  const [instance, setInstance] = useState<ReactFlowInstance<CityFlowNode, TradeFlowEdge> | null>(null)
  useEffect(() => {
    const saved = loadSavedPositions(key)
    const next = calculated.map((node) => ({ ...node, position: saved[node.id] ?? node.position }))
    setNodes(next)
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(next.map((node) => [node.id, node.position]))))
  }, [calculated, key, layoutRevision])
  const directedPairs = useMemo(() => new Set(graph.edges.map((edge) => `${edge.source_area_pk}:${edge.destination_area_pk}`)), [graph.edges])
  const edges = useMemo<TradeFlowEdge[]>(() => graph.edges.map((edge) => ({
    id: edge.edge_id,
    source: `area-${edge.source_area_pk}`,
    target: `area-${edge.destination_area_pk}`,
    type: 'trade',
    data: { evidence: edge, parallel: directedPairs.has(`${edge.destination_area_pk}:${edge.source_area_pk}`) },
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    animated: edge.status === 'running' && edge.freshness === 'live' && edge.goods_verification !== 'unavailable',
    ariaLabel: `${edge.source_area_name} to ${edge.destination_area_name}, ${edge.summary.goods} goods, ${edge.status}`,
  })), [directedPairs, graph.edges])
  const onNodesChange = useCallback((changes: NodeChange<CityFlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), [])
  const savePositions = useCallback(() => {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(nodes.map((node) => [node.id, node.position]))))
  }, [key, nodes])
  const reset = () => {
    localStorage.removeItem(key)
    setLayoutRevision((value) => value + 1)
    window.setTimeout(() => instance?.fitView({ padding: .15, duration: 250 }), 0)
  }
  return <div className={`trade-network-canvas ${compact ? 'compact' : ''}`}>
    <div className="network-canvas-tools"><button onClick={() => instance?.fitView({ padding: .15, duration: 250 })}>Fit</button><button onClick={reset}>Re-layout</button></div>
    <ReactFlow<CityFlowNode, TradeFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onInit={setInstance}
      onNodesChange={onNodesChange}
      onNodeDragStop={savePositions}
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

function GraphCard({ title, description, campaignId, graphKey, graph, compact, onEdge, onNode }: {
  title: string
  description: string
  campaignId: string | null
  graphKey: GraphKey
  graph: TradeGraph
  compact?: boolean
  onEdge: (edge: TradeNetworkEdge) => void
  onNode: (node: TradeNetworkNode) => void
}) {
  const [listView, setListView] = useState(false)
  return <section className={`trade-network-card ${graphKey}`} aria-label={`${title} trade network`}>
    <header><div><strong>{title}</strong><small>{description}</small></div><button className="button ghost" onClick={() => setListView((value) => !value)}>{listView ? <Network size={13} /> : <List size={13} />}{listView ? 'Graph' : 'List'}</button></header>
    {listView ? <div className="network-list-view">{graph.edges.length ? graph.edges.map((edge) => <button key={edge.edge_id} onClick={() => onEdge(edge)}><span><strong>{edge.source_area_name}</strong><ArrowRight size={13} /><strong>{edge.destination_area_name}</strong></span><small>{edge.summary.goods} goods · {edge.summary.routes} routes · {edge.summary.ships} ships · {titleCase(edge.status)}</small></button>) : <p>No mapped trade relationships in this view.</p>}</div> : graph.nodes.length ? <ReactFlowProvider><NetworkCanvas campaignId={campaignId} graphKey={graphKey} graph={graph} compact={compact} onEdge={onEdge} onNode={onNode} /></ReactFlowProvider> : <div className="network-empty"><Network size={22} /><strong>No connected cities yet</strong><span>Plans and linked routes will appear here.</span></div>}
  </section>
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

function UnmappedRoutes({ network, areas, plans, onLink, onRelink }: { network: TradeNetworkResponse; areas: Area[]; plans: TradePlan[]; onLink: (body: { campaign_id: string; route_key: string; source_area_pk: number; destination_area_pk: number; trade_plan_id?: string }) => void; onRelink: (linkId: string, routeKey: string) => void }) {
  const [routeKey, setRouteKey] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [destination, setDestination] = useState('')
  const [planId, setPlanId] = useState('')
  if (!network.unmapped_routes.length) return null
  return <section className="panel unmapped-route-tray"><header><div><strong>Unmapped active routes</strong><small>Anno exposed ships and names, but not trustworthy stops or goods.</small></div><span>{network.unmapped_routes.length}</span></header><div>{network.unmapped_routes.map((route) => <article key={route.route_key}><span className="product-glyph"><Ship size={16} /></span><div><strong>{route.route_name}</strong><p>{route.ships.map((ship) => ship.ship_name || `Ship ${ship.ship_id}`).join(' · ') || 'No assigned ship evidence'}</p><small>{titleCase(route.status)} · {titleCase(route.freshness ?? (route.is_stale ? 'stale' : 'live'))} · session {route.game_session_guid ?? 'unknown'} · goods unknown</small>{route.relink_suggestions?.map((suggestion) => <div className="relink-suggestion" key={suggestion.link_id}><span>Possible rename of <b>{suggestion.previous_route_name}</b> ({suggestion.overlapping_ship_ids.length} matching ship ID{suggestion.overlapping_ship_ids.length === 1 ? '' : 's'}). Confirmation required.</span><button className="button ghost" onClick={() => onRelink(suggestion.link_id, route.route_key)}>Confirm relink</button></div>)}{routeKey === route.route_key && <div className="route-link-form"><label>Source<select value={source} onChange={(event) => setSource(event.target.value)}><option value="">Choose city</option>{areas.map((area) => <option value={area.area_pk} key={area.area_pk}>{area.name}</option>)}</select></label><label>Destination<select value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">Choose city</option>{areas.map((area) => <option value={area.area_pk} key={area.area_pk}>{area.name}</option>)}</select></label><label>Plan (optional)<select value={planId} onChange={(event) => {
            const next = event.target.value
            setPlanId(next)
            const plan = plans.find((item) => item.trade_plan_id === next)
            if (plan) { setSource(String(plan.source_area_pk)); setDestination(String(plan.destination_area_pk)) }
          }}><option value="">No plan</option>{plans.filter((plan) => !['completed', 'dismissed'].includes(plan.status)).map((plan) => <option value={plan.trade_plan_id} key={plan.trade_plan_id}>{plan.route_tag} · {plan.source_area_name} to {plan.destination_area_name}</option>)}</select></label><button className="button primary" disabled={!source || !destination || source === destination || !network.campaign_id} onClick={() => network.campaign_id && onLink({ campaign_id: network.campaign_id, route_key: route.route_key, source_area_pk: Number(source), destination_area_pk: Number(destination), ...(planId ? { trade_plan_id: planId } : {}) })}>Save link</button></div>}</div><button className="button ghost" onClick={() => {
          const next = routeKey === route.route_key ? null : route.route_key
          setRouteKey(next)
          if (next) { setSource(''); setDestination(''); setPlanId('') }
        }}>{routeKey === route.route_key ? <X size={13} /> : <Boxes size={13} />}{routeKey === route.route_key ? 'Cancel' : 'Link route'}</button></article>)}</div></section>
}

interface TradeNetworkProps {
  network: TradeNetworkResponse
  areas: Area[]
  plans: TradePlan[]
  onLink: (body: { campaign_id: string; route_key: string; source_area_pk: number; destination_area_pk: number; trade_plan_id?: string }) => void
  onUnlink: (linkId: string) => void
  onRelink: (linkId: string, routeKey: string) => void
  compact?: boolean
}

export function TradeNetworkCards({ network, areas, plans, onLink, onUnlink, onRelink, compact = false }: TradeNetworkProps) {
  const [selectedEdge, setSelectedEdge] = useState<TradeNetworkEdge | null>(null)
  const [selectedNode, setSelectedNode] = useState<TradeNetworkNode | null>(null)
  const allEdges = useMemo(() => Object.values(network.graphs).flatMap((graph) => graph.edges), [network.graphs])
  useEffect(() => {
    const listener = (event: Event) => {
      const edgeId = (event as CustomEvent<string>).detail
      const found = allEdges.find((edge) => edge.edge_id === edgeId)
      if (found) { setSelectedNode(null); setSelectedEdge(found) }
    }
    window.addEventListener('anno:trade-edge', listener)
    return () => window.removeEventListener('anno:trade-edge', listener)
  }, [allEdges])
  const selectEdge = (edge: TradeNetworkEdge) => { setSelectedNode(null); setSelectedEdge(edge) }
  const selectNode = (node: TradeNetworkNode) => { setSelectedEdge(null); setSelectedNode(node) }
  return <>
    <div className="trade-network-grid"><GraphCard title="Latium" description={`${network.graphs.latium.nodes.length} cities · ${network.graphs.latium.edges.length} relationships`} campaignId={network.campaign_id} graphKey="latium" graph={network.graphs.latium} compact={compact} onEdge={selectEdge} onNode={selectNode} /><GraphCard title="Albion" description={`${network.graphs.albion.nodes.length} cities · ${network.graphs.albion.edges.length} relationships`} campaignId={network.campaign_id} graphKey="albion" graph={network.graphs.albion} compact={compact} onEdge={selectEdge} onNode={selectNode} /><GraphCard title="Cross-region" description={`${network.graphs.cross_region.nodes.length} cities · ${network.graphs.cross_region.edges.length} relationships`} campaignId={network.campaign_id} graphKey="cross_region" graph={network.graphs.cross_region} compact={compact} onEdge={selectEdge} onNode={selectNode} /></div>
    <UnmappedRoutes network={network} areas={areas} plans={plans} onLink={onLink} onRelink={onRelink} />
    <div className="network-evidence-notice"><CircleHelp size={14} />{network.evidence_notice}</div>
    <EvidenceDrawer edge={selectedEdge} node={selectedNode} allEdges={allEdges} onUnlink={onUnlink} onClose={() => { setSelectedEdge(null); setSelectedNode(null) }} />
  </>
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
    <section className="trade-network-explorer"><header><div><strong>Trade network</strong><small>Relationships, not geography. Select an edge to inspect its ships and resource evidence.</small></div><div className="network-view-controls"><nav aria-label="Trade network region">{(['latium', 'albion', 'cross_region'] as GraphKey[]).map((item) => <button className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item === 'cross_region' ? 'Cross-region' : titleCase(item)}</button>)}</nav><button className="button ghost" onClick={() => setListView((value) => !value)}>{listView ? <Network size={13} /> : <List size={13} />}{listView ? 'Graph' : 'List'}</button></div></header>{listView ? <div className="network-list-view">{graph.edges.length ? graph.edges.map((edge) => <button key={edge.edge_id} onClick={() => { setSelectedNode(null); setSelectedEdge(edge) }}><span><strong>{edge.source_area_name}</strong><ArrowRight size={13} /><strong>{edge.destination_area_name}</strong></span><small>{edge.summary.goods} goods · {edge.summary.routes} routes · {edge.summary.ships} ships · {titleCase(edge.status)}</small></button>) : <p>No mapped trade relationships in this view.</p>}</div> : <ReactFlowProvider><NetworkCanvas campaignId={props.network.campaign_id} graphKey={tab} graph={graph} onEdge={(edge) => { setSelectedNode(null); setSelectedEdge(edge) }} onNode={(node) => { setSelectedEdge(null); setSelectedNode(node) }} /></ReactFlowProvider>}</section>
    <UnmappedRoutes network={props.network} areas={props.areas} plans={props.plans} onLink={props.onLink} onRelink={props.onRelink} />
    <div className="network-evidence-notice"><CircleHelp size={14} />{props.network.evidence_notice}</div>
    <EvidenceDrawer edge={selectedEdge} node={selectedNode} allEdges={allEdges} onUnlink={props.onUnlink} onClose={() => { setSelectedEdge(null); setSelectedNode(null) }} />
  </>
}
