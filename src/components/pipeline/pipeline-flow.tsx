import { Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  FileAudio,
  Filter,
  FlipVertical2,
  KeyRound,
  Lock,
  LockOpen,
  MessageSquareText,
  Binary,
  RadioTower,
  Mic,
  Music,
  Plus,
  Radio,
  Rewind,
  Shuffle,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo } from 'react'
import type { NodeKind, PipelineEdge, PipelineNode } from '../../pipeline/stage-meta'
import { cn } from '../ui/primitives'

const ICONS: Record<string, LucideIcon> = {
  secret: Mic,
  cover: Music,
  fir: Filter,
  reverse: Rewind,
  'fft-secret': Activity,
  fft: Activity,
  invert: FlipVertical2,
  permute: Shuffle,
  shift: ArrowUpFromLine,
  bandstop: Ban,
  mix: Plus,
  stego: FileAudio,
  received: Radio,
  bandpass: Filter,
  'shift-down': ArrowDownToLine,
  unpermute: KeyRound,
  uninvert: FlipVertical2,
  unreverse: Rewind,
  recovered: Volume2,
  text: MessageSquareText,
  aes: Lock,
  spread: RadioTower,
  lane: Filter,
  despread: Binary,
  decrypt: LockOpen,
  message: MessageSquareText,
}

const KIND_STYLE: Record<NodeKind, { ring: string; glow: string; icon: string }> = {
  input: { ring: 'ring-slate-400/50', glow: 'shadow-slate-400/20', icon: 'text-slate-200' },
  op: { ring: 'ring-cyan-400/70', glow: 'shadow-cyan-400/30', icon: 'text-cyan-300' },
  fft: { ring: 'ring-violet-400/80', glow: 'shadow-violet-400/40', icon: 'text-violet-300' },
  mix: { ring: 'ring-amber-400/70', glow: 'shadow-amber-400/30', icon: 'text-amber-300' },
  output: { ring: 'ring-emerald-400/80', glow: 'shadow-emerald-400/40', icon: 'text-emerald-300' },
}

interface StageNodeData extends Record<string, unknown> {
  title: string
  subtitle: string
  kind: NodeKind
  lit: boolean
  selected: boolean
  iconKey: string
  slow: boolean
}

const LIGHT_UP = { type: 'spring', stiffness: 300, damping: 22 } as const
/** Softer, slower spring for the hand-stepped walkthrough, so each block is easy to follow. */
const LIGHT_UP_SLOW = { type: 'spring', stiffness: 90, damping: 20, mass: 1.3 } as const

function StageNode({ data }: NodeProps<Node<StageNodeData>>) {
  const Icon = ICONS[data.iconKey] ?? Activity
  const style = KIND_STYLE[data.kind]
  return (
    <motion.div
      initial={false}
      animate={{ opacity: data.lit ? 1 : 0.35, scale: data.selected ? 1.06 : 1 }}
      transition={data.slow ? LIGHT_UP_SLOW : LIGHT_UP}
      className={cn(
        'w-44 cursor-pointer rounded-xl bg-ink-800/95 px-3 py-2.5 ring-1 transition-shadow',
        data.lit ? cn(style.ring, 'shadow-lg', style.glow) : 'ring-white/10',
        data.selected && 'ring-2 ring-white',
      )}
    >
      <Handle id="left" type="target" position={Position.Left} />
      <Handle id="top" type="target" position={Position.Top} />
      <div className="flex items-center gap-2.5">
        <div className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-white/5', style.icon)}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-white">{data.title}</div>
          <div className="truncate font-mono text-[10px] text-slate-400">{data.subtitle}</div>
        </div>
      </div>
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
    </motion.div>
  )
}

const nodeTypes = { stage: StageNode }

interface PipelineFlowProps<S extends string> {
  nodes: PipelineNode<S>[]
  edges: PipelineEdge[]
  /** Blocks with order <= revealed are lit. */
  revealed: number
  selectedId: string | null
  onSelect: (id: string) => void
  height?: number
  /** Gentler light-up and slower wire animation, for a walkthrough the user steps through by hand. */
  slowReveal?: boolean
}

export function PipelineFlow<S extends string>({ nodes, edges, revealed, selectedId, onSelect, height = 300, slowReveal = false }: PipelineFlowProps<S>) {
  const order = useMemo(() => new Map(nodes.map((n) => [n.id, n.order])), [nodes])

  const rfNodes = useMemo<Node<StageNodeData>[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: 'stage',
        position: { x: n.x, y: n.y },
        draggable: false,
        data: {
          title: n.title,
          subtitle: n.subtitle,
          kind: n.kind,
          lit: n.order <= revealed,
          selected: n.id === selectedId,
          iconKey: n.id,
          slow: slowReveal,
        },
      })),
    [nodes, revealed, selectedId, slowReveal],
  )

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const lit = (order.get(e.to) ?? 0) <= revealed
        const color = lit ? '#22d3ee' : '#334155'
        return {
          id: `${e.from}-${e.to}`,
          source: e.from,
          target: e.to,
          sourceHandle: e.fromSide ?? 'right',
          targetHandle: e.toSide ?? 'left',
          type: 'smoothstep',
          animated: lit,
          style: { stroke: color },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        }
      }),
    [edges, order, revealed],
  )

  return (
    <div className={cn('w-full overflow-hidden rounded-2xl bg-black/20 ring-1 ring-white/10', slowReveal && 'flow-slow')} style={{ height }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect(n.id)}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        minZoom={0.3}
      />
    </div>
  )
}
