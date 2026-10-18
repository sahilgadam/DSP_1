import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import { STEPS, useStegoStore, type StepIndex } from '../../store/use-stego-store'
import { cn } from '../ui/primitives'

const LABELS = ['Select Audio', 'Encode', 'Transmit', 'Decode', 'Results']

export function Stepper() {
  const { step, goTo, maxReachableStep } = useStegoStore()
  const reachable = maxReachableStep()

  return (
    <nav aria-label="Progress" className="flex items-center gap-1 overflow-x-auto">
      {STEPS.map((_, i) => {
        const idx = i as StepIndex
        const active = step === idx
        const done = idx < step || idx <= reachable - 1
        const enabled = idx <= reachable
        return (
          <div key={i} className="flex items-center">
            <button
              onClick={() => enabled && goTo(idx)}
              disabled={!enabled}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-left transition',
                active ? 'bg-white/10' : enabled ? 'hover:bg-white/5' : 'cursor-not-allowed opacity-40',
              )}
            >
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs font-bold ring-1',
                  active ? 'bg-cyan-400 text-ink-950 ring-cyan-300' : done ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/40' : 'text-slate-400 ring-white/15',
                )}
              >
                {done && !active ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className="hidden sm:block">
                <span className="block text-xs font-semibold text-white">{LABELS[i]}</span>
              </span>
              {active && <motion.span layoutId="step-underline" className="absolute inset-x-3 -bottom-px h-0.5 rounded bg-cyan-400" />}
            </button>
            {i < STEPS.length - 1 && <span className={cn('mx-1 h-px w-6', idx < reachable ? 'bg-cyan-400/50' : 'bg-white/10')} />}
          </div>
        )
      })}
    </nav>
  )
}
