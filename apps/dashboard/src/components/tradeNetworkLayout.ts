import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Node } from '@xyflow/react'
import type { TradeNetworkGraph, TradeNetworkNode } from '../types'

export type GraphKey = 'latium' | 'albion' | 'cross_region'
export type LayoutMode = 'network' | 'hubs' | 'focus'
export type LayoutPoint = { x: number; y: number }
export type CityNodeData = TradeNetworkNode & { layoutRole?: 'hub' | 'focus' } & Record<string, unknown>
export type CityFlowNode = Node<CityNodeData, 'city'>

export interface EdgeRoute {
  points: LayoutPoint[]
  labelPoint?: LayoutPoint
  secondary?: boolean
}

export interface TradeLayoutResult {
  nodes: CityFlowNode[]
  routes: Record<string, EdgeRoute>
  focusNodeId: string | null
  hiddenNodeCount: number
}

export const tradeNodeWidth = 240
export const tradeNodeHeight = 128

const elk = new ELK()

function toFlowNode(node: TradeNetworkNode, position: LayoutPoint, layoutRole?: CityNodeData['layoutRole']): CityFlowNode {
  return {
    id: node.node_id,
    type: 'city',
    position,
    data: { ...node, layoutRole },
    ariaLabel: `${node.area_name}, ${node.severity}, ${node.pressure_count} economic pressures${layoutRole ? `, ${layoutRole} city` : ''}`,
  }
}

function edgeNodeIds(edge: TradeNetworkGraph['edges'][number]) {
  return [`area-${edge.source_area_pk}`, `area-${edge.destination_area_pk}`] as const
}

function routeFromElkEdge(edge: ElkExtendedEdge): EdgeRoute | null {
  const section = edge.sections?.[0]
  if (!section) return null
  const label = edge.labels?.[0]
  return {
    points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    labelPoint: label?.x == null || label.y == null ? undefined : {
      x: label.x + (label.width ?? 0) / 2,
      y: label.y + (label.height ?? 0) / 2,
    },
  }
}

function edgeLabelWidth(edge: TradeNetworkGraph['edges'][number]) {
  const text = `${edge.summary.goods} goods · ${edge.summary.routes} routes · ${edge.summary.ships} ships`
  return Math.max(116, Math.min(180, text.length * 5.4))
}

async function networkLayout(graph: TradeNetworkGraph, graphKey: GraphKey): Promise<TradeLayoutResult> {
  const children: ElkNode[] = [...graph.nodes]
    .sort((left, right) => left.area_name.localeCompare(right.area_name))
    .map((node) => ({
      id: node.node_id,
      width: tradeNodeWidth,
      height: tradeNodeHeight,
      layoutOptions: graphKey === 'cross_region' ? {
        'elk.partitioning.partition': node.region === 'albion' ? '1' : '0',
      } : undefined,
    }))
  const edges: ElkExtendedEdge[] = [...graph.edges]
    .sort((left, right) => left.edge_id.localeCompare(right.edge_id))
    .map((edge) => {
      const [source, target] = edgeNodeIds(edge)
      return {
        id: edge.edge_id,
        sources: [source],
        targets: [target],
        labels: [{ id: `label-${edge.edge_id}`, width: edgeLabelWidth(edge), height: 24 }],
      }
    })
  const result = await elk.layout({
    id: 'trade-network',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=45,left=45,bottom=45,right=45]',
      'elk.spacing.nodeNode': '76',
      'elk.spacing.edgeNode': '38',
      'elk.spacing.edgeEdge': '22',
      'elk.layered.spacing.nodeNodeBetweenLayers': graphKey === 'cross_region' ? '210' : '165',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.mergeEdges': 'false',
      ...(graphKey === 'cross_region' ? { 'elk.partitioning.activate': 'true' } : {}),
    },
    children,
    edges,
  })
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]))
  const nodes = (result.children ?? []).flatMap((child) => {
    const node = byId.get(child.id)
    return node ? [toFlowNode(node, { x: child.x ?? 0, y: child.y ?? 0 })] : []
  })
  const routes = Object.fromEntries((result.edges ?? []).flatMap((edge) => {
    const route = routeFromElkEdge(edge)
    return route ? [[edge.id, route] as const] : []
  }))
  return { nodes, routes, focusNodeId: null, hiddenNodeCount: 0 }
}

function nodeDegree(graph: TradeNetworkGraph) {
  const degree = new Map(graph.nodes.map((node) => [node.node_id, 0]))
  for (const edge of graph.edges) {
    const [source, target] = edgeNodeIds(edge)
    degree.set(source, (degree.get(source) ?? 0) + 1)
    degree.set(target, (degree.get(target) ?? 0) + 1)
  }
  return degree
}

export function selectTradeHub(graph: TradeNetworkGraph): string | null {
  const degree = nodeDegree(graph)
  return [...graph.nodes]
    .sort((left, right) => (degree.get(right.node_id) ?? 0) - (degree.get(left.node_id) ?? 0) || left.area_name.localeCompare(right.area_name))[0]?.node_id ?? null
}

function radialSpanningTree(graph: TradeNetworkGraph, rootId: string): ElkExtendedEdge[] {
  const degree = nodeDegree(graph)
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]))
  const adjacency = new Map(graph.nodes.map((node) => [node.node_id, new Set<string>()]))
  for (const edge of graph.edges) {
    const [source, target] = edgeNodeIds(edge)
    adjacency.get(source)?.add(target)
    adjacency.get(target)?.add(source)
  }
  const orderedNeighbors = (nodeId: string) => [...(adjacency.get(nodeId) ?? [])].sort((left, right) => {
    return (degree.get(right) ?? 0) - (degree.get(left) ?? 0)
      || (byId.get(left)?.area_name ?? left).localeCompare(byId.get(right)?.area_name ?? right)
  })
  const visited = new Set([rootId])
  const queue = [rootId]
  const tree: ElkExtendedEdge[] = []
  const traverse = () => {
    while (queue.length) {
      const parent = queue.shift()!
      for (const child of orderedNeighbors(parent)) {
        if (visited.has(child)) continue
        visited.add(child)
        queue.push(child)
        tree.push({ id: `hub-tree-${parent}-${child}`, sources: [parent], targets: [child] })
      }
    }
  }
  traverse()
  for (const node of [...graph.nodes].sort((left, right) => left.area_name.localeCompare(right.area_name))) {
    if (visited.has(node.node_id)) continue
    visited.add(node.node_id)
    queue.push(node.node_id)
    tree.push({ id: `hub-tree-${rootId}-${node.node_id}`, sources: [rootId], targets: [node.node_id] })
    traverse()
  }
  return tree
}

function radialEdgeRoute(source: CityFlowNode, target: CityFlowNode, laneOffset: number): EdgeRoute {
  const sourceCenter = { x: source.position.x + tradeNodeWidth / 2, y: source.position.y + tradeNodeHeight / 2 }
  const targetCenter = { x: target.position.x + tradeNodeWidth / 2, y: target.position.y + tradeNodeHeight / 2 }
  const dx = targetCenter.x - sourceCenter.x
  const dy = targetCenter.y - sourceCenter.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const normal = { x: -dy / distance, y: dx / distance }
  const sourceScale = 1 / Math.max(Math.abs(dx) / (tradeNodeWidth / 2), Math.abs(dy) / (tradeNodeHeight / 2), 1 / distance)
  const targetScale = 1 / Math.max(Math.abs(dx) / (tradeNodeWidth / 2), Math.abs(dy) / (tradeNodeHeight / 2), 1 / distance)
  const start = {
    x: sourceCenter.x + dx * sourceScale + normal.x * laneOffset,
    y: sourceCenter.y + dy * sourceScale + normal.y * laneOffset,
  }
  const end = {
    x: targetCenter.x - dx * targetScale + normal.x * laneOffset,
    y: targetCenter.y - dy * targetScale + normal.y * laneOffset,
  }
  return { points: [start, end], labelPoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } }
}

async function hubsLayout(graph: TradeNetworkGraph): Promise<TradeLayoutResult> {
  const rootId = selectTradeHub(graph)
  if (!rootId) return { nodes: [], routes: {}, focusNodeId: null, hiddenNodeCount: 0 }
  const root = graph.nodes.find((node) => node.node_id === rootId)!
  const ordered = [root, ...graph.nodes.filter((node) => node.node_id !== rootId).sort((left, right) => left.area_name.localeCompare(right.area_name))]
  const result = await elk.layout({
    id: 'trade-hubs',
    layoutOptions: {
      'elk.algorithm': 'radial',
      'elk.radial.centerOnRoot': 'true',
      'elk.radial.radius': String(Math.max(390, graph.nodes.length * 58)),
      'elk.spacing.nodeNode': '90',
      'elk.padding': '[top=45,left=45,bottom=45,right=45]',
    },
    children: ordered.map((node) => ({ id: node.node_id, width: tradeNodeWidth, height: tradeNodeHeight })),
    edges: radialSpanningTree(graph, rootId),
  })
  const minX = Math.min(0, ...(result.children ?? []).map((child) => child.x ?? 0))
  const minY = Math.min(0, ...(result.children ?? []).map((child) => child.y ?? 0))
  const byId = new Map(graph.nodes.map((node) => [node.node_id, node]))
  const nodes = (result.children ?? []).flatMap((child) => {
    const node = byId.get(child.id)
    return node ? [toFlowNode(node, { x: (child.x ?? 0) - minX + 45, y: (child.y ?? 0) - minY + 45 }, child.id === rootId ? 'hub' : undefined)] : []
  })
  const byNodeId = new Map(nodes.map((node) => [node.id, node]))
  const directedPairs = new Set(graph.edges.map((edge) => `${edge.source_area_pk}:${edge.destination_area_pk}`))
  const routes = Object.fromEntries(graph.edges.flatMap((edge) => {
    const [sourceId, targetId] = edgeNodeIds(edge)
    const source = byNodeId.get(sourceId)
    const target = byNodeId.get(targetId)
    if (!source || !target) return []
    const parallel = directedPairs.has(`${edge.destination_area_pk}:${edge.source_area_pk}`)
    const laneOffset = parallel ? (edge.source_area_pk < edge.destination_area_pk ? -12 : 12) : 0
    return [[edge.edge_id, radialEdgeRoute(source, target, laneOffset)] as const]
  }))
  return { nodes, routes, focusNodeId: rootId, hiddenNodeCount: 0 }
}

function adjacencyFor(graph: TradeNetworkGraph) {
  const outgoing = new Map(graph.nodes.map((node) => [node.node_id, new Set<string>()]))
  const incoming = new Map(graph.nodes.map((node) => [node.node_id, new Set<string>()]))
  for (const edge of graph.edges) {
    const [source, target] = edgeNodeIds(edge)
    outgoing.get(source)?.add(target)
    incoming.get(target)?.add(source)
  }
  return { outgoing, incoming }
}

function distancesFrom(rootId: string, adjacency: Map<string, Set<string>>) {
  const distances = new Map([[rootId, 0]])
  const queue = [rootId]
  while (queue.length) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (distances.has(next)) continue
      distances.set(next, distances.get(current)! + 1)
      queue.push(next)
    }
  }
  return distances
}

function midpointOnRoute(points: LayoutPoint[]): LayoutPoint | undefined {
  if (points.length < 2) return undefined
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y))
  const halfway = lengths.reduce((sum, length) => sum + length, 0) / 2
  let traversed = 0
  for (let index = 0; index < lengths.length; index += 1) {
    if (traversed + lengths[index] < halfway) { traversed += lengths[index]; continue }
    const ratio = lengths[index] ? (halfway - traversed) / lengths[index] : 0
    return {
      x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
      y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
    }
  }
  return points.at(-1)
}

function focusEdgeRoute(source: CityFlowNode, target: CityFlowNode, laneOffset: number): EdgeRoute {
  const sourceCenter = { x: source.position.x + tradeNodeWidth / 2, y: source.position.y + tradeNodeHeight / 2 + laneOffset }
  const targetCenter = { x: target.position.x + tradeNodeWidth / 2, y: target.position.y + tradeNodeHeight / 2 + laneOffset }
  let points: LayoutPoint[]
  if (Math.abs(source.position.x - target.position.x) < 20) {
    const down = target.position.y > source.position.y
    const start = { x: sourceCenter.x + laneOffset, y: source.position.y + (down ? tradeNodeHeight : 0) }
    const end = { x: targetCenter.x + laneOffset, y: target.position.y + (down ? 0 : tradeNodeHeight) }
    const middleY = (start.y + end.y) / 2
    points = [start, { x: start.x, y: middleY }, { x: end.x, y: middleY }, end]
  } else {
    const right = target.position.x > source.position.x
    const start = { x: source.position.x + (right ? tradeNodeWidth : 0), y: sourceCenter.y }
    const end = { x: target.position.x + (right ? 0 : tradeNodeWidth), y: targetCenter.y }
    const middleX = (start.x + end.x) / 2 + laneOffset
    points = [start, { x: middleX, y: start.y }, { x: middleX, y: end.y }, end]
  }
  return { points, labelPoint: midpointOnRoute(points) }
}

function focusLayout(graph: TradeNetworkGraph, requestedRootId: string | null): TradeLayoutResult {
  const rootId = requestedRootId && graph.nodes.some((node) => node.node_id === requestedRootId) ? requestedRootId : selectTradeHub(graph)
  if (!rootId) return { nodes: [], routes: {}, focusNodeId: null, hiddenNodeCount: 0 }
  const { outgoing, incoming } = adjacencyFor(graph)
  const undirected = new Map(graph.nodes.map((node) => [node.node_id, new Set([...(outgoing.get(node.node_id) ?? []), ...(incoming.get(node.node_id) ?? [])])]))
  const connected = distancesFrom(rootId, undirected)
  const upstream = distancesFrom(rootId, incoming)
  const downstream = distancesFrom(rootId, outgoing)
  const levels = new Map<string, number>([[rootId, 0]])
  const weak = distancesFrom(rootId, undirected)
  for (const node of graph.nodes) {
    if (node.node_id === rootId || !connected.has(node.node_id)) continue
    const up = upstream.get(node.node_id)
    const down = downstream.get(node.node_id)
    if (up != null && down != null) levels.set(node.node_id, up < down ? -up : down)
    else if (up != null) levels.set(node.node_id, -up)
    else if (down != null) levels.set(node.node_id, down)
    else levels.set(node.node_id, (node.area_name.localeCompare(graph.nodes.find((item) => item.node_id === rootId)?.area_name ?? '') < 0 ? -1 : 1) * (weak.get(node.node_id) ?? 1))
  }
  const columns = new Map<number, TradeNetworkNode[]>()
  for (const node of graph.nodes) {
    const level = levels.get(node.node_id)
    if (level == null) continue
    const current = columns.get(level) ?? []
    current.push(node)
    columns.set(level, current)
  }
  for (const nodes of columns.values()) nodes.sort((left, right) => left.area_name.localeCompare(right.area_name))
  const orderedLevels = [...columns.keys()].sort((left, right) => left - right)
  const maxColumnHeight = Math.max(...[...columns.values()].map((nodes) => nodes.length * tradeNodeHeight + Math.max(0, nodes.length - 1) * 72))
  const minLevel = Math.min(...orderedLevels)
  const nodes = orderedLevels.flatMap((level) => {
    const column = columns.get(level)!
    const height = column.length * tradeNodeHeight + Math.max(0, column.length - 1) * 72
    return column.map((node, index) => toFlowNode(node, {
      x: 55 + (level - minLevel) * (tradeNodeWidth + 180),
      y: 55 + (maxColumnHeight - height) / 2 + index * (tradeNodeHeight + 72),
    }, node.node_id === rootId ? 'focus' : undefined))
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const directedPairs = new Set(graph.edges.map((edge) => `${edge.source_area_pk}:${edge.destination_area_pk}`))
  const routes = Object.fromEntries(graph.edges.flatMap((edge) => {
    const [sourceId, targetId] = edgeNodeIds(edge)
    const source = byId.get(sourceId)
    const target = byId.get(targetId)
    if (!source || !target) return []
    const parallel = directedPairs.has(`${edge.destination_area_pk}:${edge.source_area_pk}`)
    const laneOffset = parallel ? (edge.source_area_pk < edge.destination_area_pk ? -13 : 13) : 0
    const route = focusEdgeRoute(source, target, laneOffset)
    route.secondary = levels.get(targetId) !== (levels.get(sourceId) ?? 0) + 1
    return [[edge.edge_id, route] as const]
  }))
  return {
    nodes,
    routes,
    focusNodeId: rootId,
    hiddenNodeCount: graph.nodes.length - nodes.length,
  }
}

export function fallbackTradeLayout(graph: TradeNetworkGraph, focusNodeId: string | null = null): TradeLayoutResult {
  const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)))
  const nodes = [...graph.nodes]
    .sort((left, right) => left.area_name.localeCompare(right.area_name))
    .map((node, index) => toFlowNode(node, {
      x: 55 + (index % columns) * (tradeNodeWidth + 80),
      y: 55 + Math.floor(index / columns) * (tradeNodeHeight + 80),
    }, node.node_id === focusNodeId ? 'focus' : undefined))
  return { nodes, routes: {}, focusNodeId, hiddenNodeCount: 0 }
}

export async function calculateTradeLayout(graph: TradeNetworkGraph, graphKey: GraphKey, mode: LayoutMode, focusNodeId: string | null = null): Promise<TradeLayoutResult> {
  if (!graph.nodes.length) return { nodes: [], routes: {}, focusNodeId: null, hiddenNodeCount: 0 }
  if (mode === 'network') return networkLayout(graph, graphKey)
  if (mode === 'hubs') return hubsLayout(graph)
  return focusLayout(graph, focusNodeId)
}
