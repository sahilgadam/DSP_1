import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from './primitives'

/** Accent used by a Sender panel: cyan = carrier, violet = voice lane, emerald = text lane, amber = key. */
export type Accent = 'cyan' | 'violet' | 'emerald' | 'amber'

interface AccentStyle {
  tile: string
  eyebrow: string
  rule: string
  hover: string
  filled: string
}

const ACCENTS: Record<Accent, AccentStyle> = {
  cyan: {
    tile: 'bg-cyan-400/10 text-cyan-300 ring-cyan-400/25',
    eyebrow: 'text-cyan-300',
    rule: 'from-cyan-400/70 via-cyan-400/15',
    hover: 'hover:border-cyan-300/35 hover:shadow-cyan-500/10',
    filled: 'border-cyan-300/25',
  },
  violet: {
    tile: 'bg-violet-400/10 text-violet-300 ring-violet-400/25',
    eyebrow: 'text-violet-300',
    rule: 'from-violet-400/70 via-violet-400/15',
    hover: 'hover:border-violet-300/35 hover:shadow-violet-500/10',
    filled: 'border-violet-300/25',
  },
  emerald: {
    tile: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/25',
    eyebrow: 'text-emerald-300',
    rule: 'from-emerald-400/70 via-emerald-400/15',
    hover: 'hover:border-emerald-300/35 hover:shadow-emerald-500/10',
    filled: 'border-emerald-300/25',
  },
  amber: {
    tile: 'bg-amber-400/10 text-amber-200 ring-amber-400/25',
    eyebrow: 'text-amber-200',
    rule: 'from-amber-400/70 via-amber-400/15',
    hover: 'hover:border-amber-300/35 hover:shadow-amber-500/10',
    filled: 'border-amber-300/25',
  },
}

/** Small heading above a group of panels. */
export function SectionHeading({
  eyebrow,
  title,
  hint,
  accent = 'cyan',
  right,
}: {
  eyebrow: string
  title: string
  hint?: string
  accent?: Accent
  right?: ReactNode
}) {
  const a = ACCENTS[accent]
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('font-mono text-[10px] font-semibold uppercase tracking-[0.2em]', a.eyebrow)}>{eyebrow}</span>
          <span aria-hidden="true" className={cn('h-px w-10 bg-gradient-to-r to-transparent', a.rule)} />
        </div>
        <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-white">{title}</h2>
        {hint && <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-slate-400">{hint}</p>}
      </div>
      {right}
    </div>
  )
}

type PillTone = 'ready' | 'idle' | 'optional' | 'warn'

const PILL_TONES: Record<PillTone, string> = {
  ready: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
  idle: 'bg-white/5 text-slate-400 ring-white/10',
  optional: 'bg-white/5 text-slate-500 ring-white/10',
  warn: 'bg-amber-400/10 text-amber-200 ring-amber-400/30',
}

export function StatusPill({ tone, label }: { tone: PillTone; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1', PILL_TONES[tone])}>
      {tone === 'ready' && <Check className="size-3" aria-hidden="true" />}
      {label}
    </span>
  )
}

interface PanelProps {
  accent: Accent
  icon: ReactNode
  eyebrow: string
  title: string
  hint: string
  /** Shown next to the eyebrow — usually a <StatusPill />. */
  status?: ReactNode
  /** Buttons; placed beside the header on wide panels, under it otherwise. */
  actions?: ReactNode
  /** Status strip pinned to the bottom so paired panels line up. */
  footer?: ReactNode
  children: ReactNode
  /** Header and actions sit side by side (used by the full-width carrier panel). */
  wide?: boolean
  /** Highlights the border once the panel holds content. */
  filled?: boolean
  delay?: number
  className?: string
}

/**
 * Shared shell for the Sender panels. Every region (header, actions, body, footer) keeps the same
 * structure and minimum height in both panels of a pair, so side-by-side cards line up row for row.
 */
export function Panel({ accent, icon, eyebrow, title, hint, status, actions, footer, children, wide, filled, delay = 0, className }: PanelProps) {
  const a = ACCENTS[accent]
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
      className={cn(
        'relative flex h-full flex-col overflow-hidden rounded-2xl border bg-ink-900/70 shadow-xl shadow-black/30 backdrop-blur transition-colors duration-300',
        filled ? a.filled : 'border-white/10',
        a.hover,
        className,
      )}
    >
      <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-px bg-gradient-to-r to-transparent', a.rule)} />
      <div className={cn('flex gap-4 p-5 pb-4', wide ? 'flex-col lg:flex-row lg:items-start lg:justify-between' : 'flex-col')}>
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl ring-1', a.tile)}>{icon}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('font-mono text-[10px] font-semibold uppercase tracking-[0.16em]', a.eyebrow)}>{eyebrow}</span>
              {status}
            </div>
            <h3 className="mt-1 text-base font-semibold tracking-tight text-white">{title}</h3>
            <p className={cn('mt-1 text-xs leading-relaxed text-slate-400', !wide && 'min-h-[2.5rem]')}>{hint}</p>
          </div>
        </div>
        {actions && <div className={cn('flex flex-wrap gap-2', wide && 'shrink-0 lg:justify-end')}>{actions}</div>}
      </div>
      <div className="flex grow flex-col px-5">{children}</div>
      <div className="px-5 pb-5 pt-3">{footer}</div>
    </motion.div>
  )
}
