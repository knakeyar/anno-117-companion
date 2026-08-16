import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import { AlertTriangle, ChevronDown, ChevronUp, Factory, PackageOpen, Pickaxe, RefreshCw, X } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type { ProductionExplorerResponse, ProductionFactoryNode, ProductionResourceNode, ProductionStatus } from '../types'
import { formatNumber, formatRate, titleCase } from '../utils'
import {
  calculateProductionLayout,
  fallbackProductionLayout,
  type ProductionFlowNode,
  type ProductionNodeData,
} from './productionChainLayout'

function ResourceGlyph({ icon, raw = false }: { icon: string | null; raw?: boolean }) {
  if (icon) return <img className="production-node-icon" src={icon} alt="" />
  return <span className="production-node-icon fallback">{raw ? <Pickaxe size={23} /> : <PackageOpen size={23} />}</span>
}

function statusLabel(status: ProductionStatus): string {
  if (status === 'missing') return 'Not installed'
  if (status === 'deficit') return 'Capacity shortfall'
  if (status === 'constrained') return 'Near capacity'
  if (status === 'risk') return 'Stock risk'
  if (status === 'import_required') return 'Import required'
  if (status === 'raw') return 'Raw resource'
  return titleCase(status)
}

function ProductionCard({ data, selected }: NodeProps<ProductionFlowNode>) {
  if (data.nodeKind === 'resource') {
    const node = data.value
    return <article className={`production-resource-node status-${node.status} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <header><ResourceGlyph icon={node.icon} raw={node.status === 'raw'} /><span><small>Resource</small><strong>{node.name}</strong></span></header>
      <div className="production-node-primary"><span><small>Required</small><b>{node.required_rate == null ? 'Unknown' : `${formatNumber(node.required_rate, 2)}/min`}</b></span></div>
      <footer><span>Stock <b>{formatNumber(node.stock)}</b></span><span>{node.stock_trend == null ? 'Trend unavailable' : `Net ${formatRate(node.stock_trend)}`}</span></footer>
      {node.status !== 'healthy' && node.status !== 'neutral' && <em><AlertTriangle size={11} /> {statusLabel(node.status)}</em>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  }
  const node = data.value
  const capacityPercent = node.utilization == null ? 0 : Math.min(100, node.utilization * 100)
  return <article className={`production-factory-node status-${node.status} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <header><span className="production-node-icon fallback"><Factory size={23} /></span><span><small>Production building</small><strong>{node.building_name}</strong></span></header>
    <div className="production-factory-metrics"><span><small>Output required</small><b>{node.required_output_rate == null ? '—' : `${formatNumber(node.required_output_rate, 2)}/min`}</b></span><span><small>Buildings</small><b>{formatNumber(node.required_buildings, 2)} req. · {formatNumber(node.installed_buildings)} built</b></span></div>
    <div className={`production-capacity-track status-${node.status}`}><i style={{ width: `${capacityPercent}%` }} /></div>
    <footer><span>{node.capacity_balance_buildings == null ? 'Capacity unknown' : `${node.capacity_balance_buildings >= 0 ? '+' : ''}${formatNumber(node.capacity_balance_buildings, 2)} buildings`}</span><span>{formatNumber(node.cycle_seconds, 1)}s cycle</span></footer>
    {node.status !== 'healthy' && node.status !== 'neutral' && <em><AlertTriangle size={11} /> {statusLabel(node.status)}</em>}
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </article>
}

const nodeTypes = { productionNode: ProductionCard }

function EvidenceDrawer({
  selected,
  data,
  collapsed,
  onClose,
  onRoot,
  onCollapse,
  onRecipe,
}: {
  selected: ProductionNodeData | null
  data: ProductionExplorerResponse
  collapsed: Set<string>
  onClose: () => void
  onRoot: (productGuid: string) => void
  onCollapse: (nodeId: string) => void
  onRecipe: (productGuid: string, recipeId: string) => void
}) {
  if (!selected) return null
  const resource = selected.nodeKind === 'resource' ? selected.value : null
  const factory = selected.nodeKind === 'factory' ? selected.value : null
  const isRoot = resource?.product_guid === data.root_product_guid
  const hasProducer = Boolean(resource?.producer_factory_id)
  const factoryInputs = factory ? data.edges.filter((edge) => edge.source === factory.node_id && edge.kind === 'requires').map((edge) => ({
    edge,
    resource: data.resources.find((item) => item.node_id === edge.target),
  })) : []
  return <div className="drawer-backdrop" role="presentation" onClick={onClose}><aside className="network-evidence-drawer production-evidence-drawer" role="dialog" aria-modal="true" aria-label={resource ? `Production details for ${resource.name}` : `Factory details for ${factory!.building_name}`} onClick={(event) => event.stopPropagation()}>
    <button className="icon-button drawer-close" aria-label="Close production details" onClick={onClose}><X size={16} /></button>
    {resource ? <>
      <span className={`route-status ${resource.status}`}>{statusLabel(resource.status)}</span>
      <h2><ResourceGlyph icon={resource.icon} raw={resource.status === 'raw'} />{resource.name}</h2>
      <div className="production-drawer-summary"><span><small>Required throughput</small><b>{resource.required_rate == null ? 'Unknown' : `${formatNumber(resource.required_rate, 2)}/min`}</b></span><span><small>Current stock</small><b>{formatNumber(resource.stock)}</b></span><span><small>Net stock change</small><b>{formatRate(resource.stock_trend)}</b></span></div>
      {isRoot && <section><h3>Automatic demand</h3><dl className="production-evidence-list"><div><dt>Population</dt><dd>{formatRate(data.demand.population)}</dd></div><div><dt>Production inputs</dt><dd>{formatRate(data.demand.production)}</dd></div><div><dt>Construction</dt><dd>{data.demand.construction == null ? 'Not observed' : formatRate(data.demand.construction)}</dd></div></dl>{data.demand.sources.length > 0 && <div className="production-demand-sources">{data.demand.sources.map((source) => <span key={source.recipe_id}><b>{source.building_name ?? source.building_guid}</b><small>{formatRate(source.rate_per_minute)} modeled input demand · {source.building_count} installed</small></span>)}</div>}<p>Demand comes from the same city model as City Stock Stats; no manual target is required.</p></section>}
      <section><h3>Evidence</h3>{resource.alerts.length ? resource.alerts.map((alert) => <p className="production-node-alert" key={alert.code}><AlertTriangle size={13} /> {alert.label}</p>) : <p>No stock-derived warning is attached to this resource.</p>}<p>Stock movement is secondary evidence and is not treated as a measured production rate.</p></section>
      <div className="production-drawer-actions">{!isRoot && <button className="button primary" onClick={() => { onRoot(resource.product_guid); onClose() }}>Make diagram root</button>}{hasProducer && <button className="button ghost" onClick={() => onCollapse(resource.node_id)}>{collapsed.has(resource.node_id) ? <ChevronDown size={14} /> : <ChevronUp size={14} />}{collapsed.has(resource.node_id) ? 'Show upstream chain' : 'Collapse upstream chain'}</button>}</div>
    </> : <>
      <span className={`route-status ${factory!.status}`}>{statusLabel(factory!.status)}</span>
      <h2><Factory size={22} />{factory!.building_name}</h2>
      <div className="production-drawer-summary"><span><small>Required buildings</small><b>{formatNumber(factory!.required_buildings, 2)}</b></span><span><small>Installed</small><b>{formatNumber(factory!.installed_buildings)}</b></span><span><small>Capacity balance</small><b>{factory!.capacity_balance_rate == null ? 'Unknown' : formatRate(factory!.capacity_balance_rate)}</b></span></div>
      <section><h3>Base recipe</h3><dl className="production-evidence-list"><div><dt>Cycle time</dt><dd>{formatNumber(factory!.cycle_seconds, 1)} seconds</dd></div><div><dt>Output per building</dt><dd>{formatRate(factory!.output_per_minute_per_building)}</dd></div><div><dt>Output quantity</dt><dd>{formatNumber(factory!.output_amount, 2)} per cycle</dd></div><div><dt>Whole buildings needed</dt><dd>{formatNumber(factory!.buildings_needed)}</dd></div><div><dt>Workforce</dt><dd>{factory!.workforce_name ?? 'Unknown'}</dd></div><div><dt>Base maintenance</dt><dd>{formatNumber(factory!.base_maintenance)}</dd></div></dl>{factoryInputs.length > 0 && <div className="production-recipe-inputs"><small>Required inputs</small>{factoryInputs.map(({ edge, resource: input }) => <span key={edge.edge_id}><ResourceGlyph icon={input?.icon ?? null} raw={input?.status === 'raw'} /><b>{input?.name ?? edge.target}<small>{formatNumber(edge.recipe_amount, 2)} per cycle</small></b><em>{edge.required_rate == null ? 'rate unknown' : `${formatNumber(edge.required_rate, 2)}/min`}</em></span>)}</div>}<p>Capacity uses catalog base cycles and observed installed-building counts. Productivity modifiers are not currently observed.</p></section>
      {factory!.alternatives.length > 1 && <section><h3>Available recipes</h3><div className="production-recipe-options">{factory!.alternatives.map((recipe) => <button className={recipe.selected ? 'active' : ''} key={recipe.recipe_id} onClick={() => onRecipe(factory!.output_product_guid, recipe.recipe_id)}><span><strong>{recipe.building_name}</strong><small>{formatRate(recipe.output_per_minute)} per building · {formatNumber(recipe.installed_buildings)} installed</small></span>{recipe.selected ? 'Selected' : 'Use recipe'}</button>)}</div></section>}
    </>}
  </aside></div>
}

export function ProductionChainGraph({ data, onRoot, onRecipe }: {
  data: ProductionExplorerResponse
  onRoot: (productGuid: string) => void
  onRecipe: (productGuid: string, recipeId: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [layout, setLayout] = useState(() => fallbackProductionLayout(data))
  const [selected, setSelected] = useState<ProductionNodeData | null>(null)
  const [instance, setInstance] = useState<ReactFlowInstance<ProductionFlowNode, Edge> | null>(null)
  const [isLayouting, setIsLayouting] = useState(false)
  const [layoutError, setLayoutError] = useState(false)
  useEffect(() => { setCollapsed(new Set()); setSelected(null) }, [data.root_product_guid, data.area.area_pk])
  useEffect(() => {
    let current = true
    setIsLayouting(true)
    setLayoutError(false)
    void calculateProductionLayout(data, collapsed).then((next) => {
      if (!current) return
      setLayout(next)
      setIsLayouting(false)
      window.setTimeout(() => instance?.fitView({ padding: .16, duration: 280 }), 0)
    }).catch(() => {
      if (!current) return
      setLayout(fallbackProductionLayout(data, collapsed))
      setLayoutError(true)
      setIsLayouting(false)
    })
    return () => { current = false }
  }, [collapsed, data, instance])
  const edges = useMemo<Edge[]>(() => data.edges.filter((edge) => layout.visibleNodeIds.has(edge.source) && layout.visibleNodeIds.has(edge.target)).map((edge) => ({
    id: edge.edge_id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    label: edge.required_rate == null ? 'rate unknown' : `${formatNumber(edge.required_rate, 2)}/min`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
    className: 'production-chain-edge',
    labelStyle: { fill: '#8ba0a1', fontSize: 9 },
    labelBgStyle: { fill: '#101c1f', fillOpacity: .94 },
    labelBgPadding: [5, 3],
    labelBgBorderRadius: 5,
    ariaLabel: `${edge.required_rate == null ? 'Unknown' : edge.required_rate} per minute required`,
  })), [data.edges, layout.visibleNodeIds])
  const toggleCollapsed = (nodeId: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
    return next
  })
  return <>
    <section className="panel production-chain-explorer" aria-label="Production chain diagram">
      <header><div><strong>Production chain</strong><small>Final requirement branches upstream through each catalog recipe.</small></div><span>{isLayouting ? 'Arranging chain…' : layoutError ? 'Using fallback layout' : `${layout.nodes.length} nodes · ${edges.length} relationships`}</span><button className="button ghost" onClick={() => instance?.fitView({ padding: .16, duration: 250 })}><RefreshCw size={13} /> Fit chain</button></header>
      <div className="production-chain-canvas">
        <ReactFlow<ProductionFlowNode, Edge>
          nodes={layout.nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setInstance}
          onNodeClick={(_event, node) => setSelected(node.data)}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: .16 }}
          minZoom={.35}
          maxZoom={1.45}
          colorMode="dark"
          ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter to inspect this production item.' }}
        ><Background color="#294044" gap={24} size={1} /><Controls showInteractive={false} /></ReactFlow>
      </div>
    </section>
    <EvidenceDrawer selected={selected} data={data} collapsed={collapsed} onClose={() => setSelected(null)} onRoot={onRoot} onCollapse={toggleCollapsed} onRecipe={onRecipe} />
  </>
}
