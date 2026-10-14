import { Eraser, MessageSquareLock, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AudioClip } from '../../audio/load-audio'
import { CHIPS_PER_BIT, LANE_HIGH_HZ, LANE_LOW_HZ } from '../../dsp/constants'
import { capacityInfo } from '../../steps/sender-validation'
import { Panel, StatusPill } from '../sender/panel'
import { Button, cn } from '../ui/primitives'

const SAMPLE_TEXT = 'Meet the DSP team at lab 4 at 5 PM. Bring the FFT notes!'

export function HiddenTextCard({
  text,
  onChange,
  cover,
  eyebrow = `Text lane · ${LANE_LOW_HZ / 1000}–${LANE_HIGH_HZ / 1000} kHz`,
  hint = `AES-256-GCM encrypted, then BPSK phase-coded with ${CHIPS_PER_BIT}× spreading. Optional — leave it empty to send voice only.`,
  notice,
  onReplace,
  delay,
}: {
  text: string
  onChange: (t: string) => void
  cover: AudioClip | null
  /** Short uppercase label above the title — the frequency lane this text travels in. */
  eyebrow?: string
  hint?: string
  /** Banner above the capacity meter, e.g. after speech-to-text filled the box. */
  notice?: ReactNode
  /** Bulk replacements (sample text, clearing) so the step can offer an undo. */
  onReplace?: (text: string, reason: 'sample' | 'clear') => void
  delay?: number
}) {
  const { limit, used, characters, remaining, over, pct, error } = capacityInfo(cover, text)
  const filled = used > 0
  const replace = onReplace ?? ((next: string) => onChange(next))

  const actions = (
    <>
      <Button variant="secondary" size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => replace(SAMPLE_TEXT, 'sample')}>
        Use sample text
      </Button>
      <Button variant="secondary" size="sm" icon={<Eraser className="size-3.5" />} onClick={() => replace('', 'clear')} disabled={!filled}>
        Clear
      </Button>
    </>
  )

  const footer = (
    <div className="space-y-2">
      {notice}
      <div className="flex items-center gap-3 text-xs">
        <div className="h-1.5 grow overflow-hidden rounded-full bg-white/10">
          <div
            className={cn('h-full rounded-full transition-all duration-300', over ? 'bg-rose-400' : 'bg-gradient-to-r from-emerald-400 to-cyan-400')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={cn('shrink-0 font-mono', over ? 'text-rose-300' : 'text-slate-400')}>
          {limit === null ? `${used} B` : `${used} / ${limit} B`}
        </span>
      </div>
      <p className={cn('text-xs leading-relaxed', over || error ? 'text-rose-300' : 'text-slate-500')}>
        {error
          ? error
          : limit === null
            ? `${characters} characters · ${used} UTF-8 bytes — load a cover track to see how many fit.`
            : over
              ? `${characters} characters · ${used} bytes — ${used - limit} too many. Shorten the text, or use a longer cover.`
              : `${characters} characters · ${used} UTF-8 bytes · ${remaining} left. Accented letters and emoji cost 2–4 bytes each.`}
      </p>
    </div>
  )

  return (
    <Panel
      accent="emerald"
      icon={<MessageSquareLock className="size-4" />}
      eyebrow={eyebrow}
      title="Hidden text message"
      hint={hint}
      status={<StatusPill tone={over ? 'warn' : filled ? 'ready' : 'optional'} label={over ? 'Too long' : filled ? 'Ready' : 'Optional'} />}
      actions={actions}
      footer={footer}
      filled={filled && !over}
      delay={delay}
    >
      <label htmlFor="hidden-text" className="sr-only">
        Hidden text message
      </label>
      <textarea
        id="hidden-text"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type a short secret text…"
        className={cn(
          'min-h-[136px] w-full grow resize-none rounded-xl bg-black/30 px-3.5 py-3 font-mono text-sm leading-relaxed text-slate-100 outline-none ring-1 transition focus:ring-emerald-300/60',
          over ? 'ring-rose-400/70' : 'ring-white/10',
        )}
      />
    </Panel>
  )
}
