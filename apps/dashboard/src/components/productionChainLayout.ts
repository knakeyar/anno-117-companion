import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Node } from '@xyflow/react'
import type { ProductionExplorerResponse, ProductionFactoryNode, ProductionResourceNode } from '../types'

export type ProductionNodeData = (
  | { nodeKind: 'resource'; value: ProductionResourceNode }
  | { nodeKind: 'factory'; value: ProductionFactoryNode }
) & Record<string, unknown>

export type ProductionFlowNode = Node<ProductionNodeData, 'productionNode'>

export interface ProductionLayoutResult {
  nodes: ProductionFlowNode[]
  visibleNodeIds: Set<string>
}

const elk = new ELK()
export const resourceNodeSize = { width: 206, height: 138 }
export const factoryNodeSize = { width: 232, height: 184 }

function reachableNodeIds(data: ProductionExplorerResponse, collapsed: Set<string>): Set<string> {
  const root = data.root_product_guid ? `resource:${data.root_product_guid}` : null
  if (!root) return new Set()
  const bySource = new Map<string, string[]>()
  for (const edge of data.edges) bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge.target])
  const visible = new Set([root])
  const queue = [root]
  while (queue.length) {
    const current = queue.shift()!
    if (collapsed.has(current)) continue
    for (const target of bySource.get(current) ?? []) {
      if (visible.has(target)) continue
      visible.add(target)
      queue.push(target)
    }
  }
  return visible
}

function flowNode(
  id: string,
  value: ProductionResourceNode | ProductionFactoryNode,
  x: number,
  y: number,
): ProductionFlowNode {
  const resource = value.kind === 'resource'
  return {
    id,
    type: 'productionNode',
    position: { x, y },
    data: resource
      ? { nodeKind: 'resource', value }
      : { nodeKind: 'factory', value },
    ariaLabel: resource
      ? `${value.name}, ${value.required_rate == null ? 'required throughput unknown' : `${value.required_rate} per minute required`}, ${value.status}`
      : `${value.building_name}, ${value.required_buildings == null ? 'required buildings unknown' : `${value.required_buildings} buildings required`}, ${value.installed_buildings == null ? 'installed count unknown' : `${value.installed_buildings} installed`}, ${value.status}`,
  }
}

export async function calculateProductionLayout(
  data: ProductionExplorerResponse,
  collapsed: Set<string> = new Set(),
): Promise<ProductionLayoutResult> {
  const visibleNodeIds = reachableNodeIds(data, collapsed)
  const resources = data.resources.filter((node) => visibleNodeIds.has(node.node_id))
  const factories = data.factories.filter((node) => visibleNodeIds.has(node.node_id))
  const children: ElkNode[] = [
    ...resources.map((node) => ({ id: node.node_id, ...resourceNodeSize })),
    ...factories.map((node) => ({ id: node.node_id, ...factoryNodeSize })),
  ]
  const edges: ElkExtendedEdge[] = data.edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .map((edge) => ({ id: edge.edge_id, sources: [edge.source], targets: [edge.target] }))
  const result = await elk.layout({
    id: 'production-chain',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=45,left=55,bottom=55,right=55]',
      'elk.spacing.nodeNode': '62',
      'elk.spacing.edgeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '86',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.mergeEdges': 'false',
    },
    children,
    edges,
  })
  const resourcesById = new Map(resources.map((node) => [node.node_id, node]))
  const factoriesById = new Map(factories.map((node) => [node.node_id, node]))
  const nodes = (result.children ?? []).flatMap((child) => {
    const value = resourcesById.get(child.id) ?? factoriesById.get(child.id)
    return value ? [flowNode(child.id, value, child.x ?? 0, child.y ?? 0)] : []
  })
  return { nodes, visibleNodeIds }
}

export function fallbackProductionLayout(
  data: ProductionExplorerResponse,
  collapsed: Set<string> = new Set(),
): ProductionLayoutResult {
  const visibleNodeIds = reachableNodeIds(data, collapsed)
  const all = [...data.resources, ...data.factories].filter((node) => visibleNodeIds.has(node.node_id))
  const byDepth = new Map<number, typeof all>()
  for (const node of all) byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node])
  const nodes = [...byDepth.entries()].flatMap(([depth, items]) => items
    .sort((left, right) => (left.kind === 'resource' ? left.name : left.building_name).localeCompare(right.kind === 'resource' ? right.name : right.building_name))
    .map((value, index) => {
      const width = value.kind === 'resource' ? resourceNodeSize.width : factoryNodeSize.width
      const total = items.length * width + Math.max(0, items.length - 1) * 55
      return flowNode(value.node_id, value, index * (width + 55) - total / 2 + 700, depth * 152 + 35)
    }))
  return { nodes, visibleNodeIds }
}
