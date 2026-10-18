import { Check, CircleDashed, CircleX, Loader2, MinusCircle } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { CARRIER_LOW_HZ, CHIPS_PER_BIT, GUARD_HZ, LANE_HIGH_HZ, LANE_LOW_HZ, NUM_SUBBANDS, SECRET_HIGH_HZ, SECRET_LOW_HZ } from '../../dsp/constants'
import { ENCODE_RUN_STAGES, type EncodeRunStage, type StageEvent } from '../../dsp/stego'
import { cn } from '../ui/primitives'

/**
 * Live encoder block diagram. Every block is one piece of code in `encode()` (or the worker around it),
 * laid out in the order it really executes, and its state comes only from the events the worker streams
 * while it runs: waiting → running → done (with the measured time) or skipped. Nothing here is a
 * simulated or pre-timed animation.
 */

export type BlockState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed'

const kHz = (hz: number) => (hz / 1000).toFixed(1)
const CARRIER_HIGH_HZ = CARRIER_LOW_HZ + SECRET_HIGH_HZ - SECRET_LOW_HZ + 2 * GUARD_HZ

export const STAGE_INFO: Record<EncodeRunStage, { title: string; sub: string; detail: string }> = {
  aes: { title: 'AES-256-GCM', sub: 'encrypt + frame', detail: 'PBKDF2-SHA256 derives the key, AES-GCM encrypts the text, a sync byte and length are prepended.' },
  fft: { title: 'FFT', sub: 'two-for-one', detail: 'One complex radix-2 FFT of z = x_s + j·x_c gives both spectra at once (just the cover when no voice is sent).' },
  fir: { title: 'FIR band-pass', sub: `${SECRET_LOW_HZ}–${SECRET_HIGH_HZ} Hz`, detail: '1023-tap Hamming windowed-sinc, applied as a product of spectra (fast convolution), group delay removed.' },
  reverse: { title: 'Time reversal', sub: 'X* · phase ramp', detail: 'x[L−1−n] ⟷ X*[k]·e^{−j2πk(L−1)/N}: the voice is reversed without leaving the frequency domain.' },
  invert: { title: 'Inversion', sub: 'f → f_lo+f_hi−f', detail: 'The speech band is mirrored: low frequencies become high and vice versa.' },
  permute: { title: 'Permutation', sub: `${NUM_SUBBANDS} sub-bands · key`, detail: `The band is cut into ${NUM_SUBBANDS} sub-bands and shuffled by a key-seeded Fisher–Yates permutation.` },
  bandstop: { title: 'Band-stop', sub: 'zero hidden bins', detail: 'The cover bins where the hidden lanes go are zeroed so they cannot collide.' },
  shift: { title: 'Shift + scale', sub: `→ ${kHz(CARRIER_LOW_HZ)}–${kHz(CARRIER_HIGH_HZ)} kHz`, detail: 'The scrambled band is scaled to the chosen level and moved up to the carrier band (Hermitian mirror kept).' },
  spread: { title: 'BPSK spread', sub: `→ ${kHz(LANE_LOW_HZ)}–${kHz(LANE_HIGH_HZ)} kHz`, detail: `Each bit is phase-coded onto ${CHIPS_PER_BIT} bins times a key-seeded ±1 chip sequence.` },
  ifft: { title: 'Inverse FFT', sub: 'back to time', detail: 'Two-for-one inverse FFTs return the stego file plus the intermediate signals you can inspect below.' },
  limit: { title: 'Peak limit', sub: 'never clips', detail: 'If the sum peaks above 0.99 the whole file is scaled down, so a 16-bit WAV never clips.' },
  analysis: { title: 'Display analysis', sub: 'PSD + spectrograms', detail: 'Welch spectra and spectrograms for the charts. This is not part of the encoder.' },
}

export function blockState(progress: Partial<Record<EncodeRunStage, StageEvent>>, stage: EncodeRunStage, failed: boolean): BlockState {
  const e = progress[stage]
  if (!e) return 'waiting'
  if (e.status === 'running') return failed ? 'failed' : 'running'
  return e.status
}

interface Props {
  progress: Partial<Record<EncodeRunStage, StageEvent>>
  /** The run ended with an error: the block that was running is marked failed. */
  failed: boolean
  fftSize?: number | null
}

// ----- schematic geometry (SVG user units) -------------------------------------------------------
const W = 128
const H = 68
const COL = 144
const X0 = 12
const ROW = { voice: 30, cover: 160, text: 290 }
const col = (i: number) => X0 + i * COL
const SIGMA = { cx: col(7) + 50, cy: ROW.cover + H / 2, r: 22 }

type Pos = { x: number; y: number; h?: number }
const POS: Partial<Record<EncodeRunStage, Pos>> = {
  fft: { x: col(1), y: ROW.voice, h: ROW.cover + H - ROW.voice },
  fir: { x: col(2), y: ROW.voice },
  reverse: { x: col(3), y: ROW.voice },
  invert: { x: col(4), y: ROW.voice },
  permute: { x: col(5), y: ROW.voice },
  shift: { x: col(6), y: ROW.voice },
  bandstop: { x: col(4), y: ROW.cover },
  aes: { x: col(1), y: ROW.text },
  spread: { x: col(6), y: ROW.text },
  ifft: { x: col(8), y: ROW.cover },
  limit: { x: col(9), y: ROW.cover },
}
const VIEW_W = col(10) + W + 12
const VIEW_H = ROW.text + H + 16

const midY = (y: number) => y + H / 2

/** Wires: `from` must be finished for the wire to carry signal; `to` is the block it feeds. */
type WireFrom = EncodeRunStage | 'input' | 'sigma'
const WIRES: { id: string; from: WireFrom; to: EncodeRunStage | 'sigma' | 'output'; points: [number, number][]; label?: string }[] = [
  { id: 'xs', from: 'input', to: 'fft', points: [[col(0) + W, midY(ROW.voice)], [col(1), midY(ROW.voice)]] },
  { id: 'xc', from: 'input', to: 'fft', points: [[col(0) + W, midY(ROW.cover)], [col(1), midY(ROW.cover)]] },
  { id: 'fft-fir', from: 'fft', to: 'fir', points: [[col(1) + W, midY(ROW.voice)], [col(2), midY(ROW.voice)]] },
  { id: 'fir-rev', from: 'fir', to: 'reverse', points: [[col(2) + W, midY(ROW.voice)], [col(3), midY(ROW.voice)]] },
  { id: 'rev-inv', from: 'reverse', to: 'invert', points: [[col(3) + W, midY(ROW.voice)], [col(4), midY(ROW.voice)]] },
  { id: 'inv-perm', from: 'invert', to: 'permute', points: [[col(4) + W, midY(ROW.voice)], [col(5), midY(ROW.voice)]] },
  { id: 'perm-shift', from: 'permute', to: 'shift', points: [[col(5) + W, midY(ROW.voice)], [col(6), midY(ROW.voice)]] },
  { id: 'fft-bs', from: 'fft', to: 'bandstop', points: [[col(1) + W, midY(ROW.cover)], [col(4), midY(ROW.cover)]], label: 'X_c[k]' },
  { id: 'shift-sum', from: 'shift', to: 'sigma', points: [[col(6) + W, midY(ROW.voice)], [SIGMA.cx, midY(ROW.voice)], [SIGMA.cx, SIGMA.cy - SIGMA.r]] },
  { id: 'bs-sum', from: 'bandstop', to: 'sigma', points: [[col(4) + W, midY(ROW.cover)], [SIGMA.cx - SIGMA.r, SIGMA.cy]] },
  { id: 'txt-aes', from: 'input', to: 'aes', points: [[col(0) + W, midY(ROW.text)], [col(1), midY(ROW.text)]] },
  { id: 'aes-spread', from: 'aes', to: 'spread', points: [[col(1) + W, midY(ROW.text)], [col(6), midY(ROW.text)]], label: 'frame bits' },
  { id: 'spread-sum', from: 'spread', to: 'sigma', points: [[col(6) + W, midY(ROW.text)], [SIGMA.cx, midY(ROW.text)], [SIGMA.cx, SIGMA.cy + SIGMA.r]] },
  { id: 'sum-ifft', from: 'sigma', to: 'ifft', points: [[SIGMA.cx + SIGMA.r, SIGMA.cy], [col(8), midY(ROW.cover)]] },
  { id: 'ifft-limit', from: 'ifft', to: 'limit', points: [[col(8) + W, midY(ROW.cover)], [col(9), midY(ROW.cover)]] },
  { id: 'limit-out', from: 'limit', to: 'output', points: [[col(9) + W, midY(ROW.cover)], [col(10), midY(ROW.cover)]] },
]

const STROKE: Record<BlockState, string> = {
  waiting: '#334155',
  running: '#22d3ee',
  done: '#22d3ee',
  skipped: '#475569',
  failed: '#fb7185',
}

const fmtMs = (ms: number) => (ms < 1 ? `${ms.toFixed(2)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`)

function statusLine(state: BlockState, e?: StageEvent) {
  if (state === 'done') return e?.ms != null ? `✓ ${fmtMs(e.ms)}` : '✓ done'
  if (state === 'running') return 'running…'
  if (state === 'skipped') return 'skipped'
  if (state === 'failed') return '✕ failed'
  return 'waiting'
}

export function EncoderRunDiagram({ progress, failed, fftSize }: Props) {
  const reduce = useReducedMotion()
  const state = (s: EncodeRunStage) => blockState(progress, s, failed)
  const finished = (s: EncodeRunStage) => state(s) === 'done' || state(s) === 'skipped'
  const anyStarted = Object.keys(progress).length > 0
  const sumState: BlockState = finished('shift') && finished('bandstop') && finished('spread') ? 'done' : 'waiting'
  const outState: BlockState = state('limit') === 'done' ? 'done' : 'waiting'
  const fftSub = fftSize ? `N = 2^${Math.log2(fftSize)}` : STAGE_INFO.fft.sub

  const wireLit = (from: WireFrom) => (from === 'input' ? anyStarted : from === 'sigma' ? sumState === 'done' : state(from) === 'done')
  const wireSkipped = (from: WireFrom) => from !== 'input' && from !== 'sigma' && state(from) === 'skipped'
  const targetRunning = (to: EncodeRunStage | 'sigma' | 'output') => to !== 'sigma' && to !== 'output' && state(to) === 'running'

  return (
    <div>
      {/* Wide screens: the schematic */}
      <div className="hidden overflow-hidden rounded-2xl bg-black/25 p-3 ring-1 ring-white/10 lg:block">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-auto w-full" role="img" aria-label={ariaSummary(progress, failed)}>
          <defs>
            <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>

          {/* lane labels */}
          {[
            ['voice lane', ROW.voice - 10],
            ['cover', ROW.cover - 10],
            ['text lane', ROW.text - 10],
          ].map(([label, y]) => (
            <text key={label} x={X0} y={y} className="fill-slate-500 font-mono" fontSize={12} letterSpacing={1.5}>
              {String(label).toUpperCase()}
            </text>
          ))}

          {WIRES.map((w) => {
            const lit = wireLit(w.from)
            const skipped = wireSkipped(w.from)
            const pts = w.points.map((p) => p.join(',')).join(' ')
            const last = w.points[w.points.length - 1]
            const first = w.points[0]
            return (
              <g key={w.id}>
                <polyline
                  points={pts}
                  fill="none"
                  stroke={skipped ? '#334155' : lit ? '#22d3ee' : '#334155'}
                  strokeOpacity={lit ? 0.9 : 1}
                  strokeWidth={lit ? 2.2 : 1.6}
                  strokeDasharray={skipped ? '5 5' : undefined}
                  markerEnd="url(#erd-arrow)"
                />
                {w.label && (
                  <text x={(first[0] + last[0]) / 2} y={first[1] - 8} textAnchor="middle" className="fill-slate-500 font-mono" fontSize={12}>
                    {w.label}
                  </text>
                )}
                {!reduce && targetRunning(w.to) && w.points.length === 2 && (
                  <motion.circle
                    r={4.5}
                    fill="#22d3ee"
                    initial={{ cx: first[0], cy: first[1], opacity: 0 }}
                    animate={{ cx: [first[0], last[0]], cy: [first[1], last[1]], opacity: [0, 1, 0] }}
                    transition={{ duration: 0.7, repeat: Infinity, ease: 'linear' }}
                  />
                )}
              </g>
            )
          })}

          {/* inputs */}
          <Terminal x={col(0)} y={ROW.voice} title="Secret voice" sub="x_s[n]" lit={anyStarted && state('fir') !== 'skipped'} dim={state('fir') === 'skipped'} />
          <Terminal x={col(0)} y={ROW.cover} title="Cover" sub="x_c[n]" lit={anyStarted} />
          <Terminal x={col(0)} y={ROW.text} title="Hidden text" sub="UTF-8" lit={anyStarted && state('aes') !== 'skipped'} dim={state('aes') === 'skipped'} />

          {(Object.keys(POS) as EncodeRunStage[]).map((stage) => {
            const p = POS[stage]!
            const st = state(stage)
            const info = STAGE_INFO[stage]
            return (
              <SchematicBlock
                key={stage}
                x={p.x}
                y={p.y}
                h={p.h ?? H}
                title={info.title}
                sub={stage === 'fft' ? fftSub : info.sub}
                status={statusLine(st, progress[stage])}
                state={st}
                reduce={!!reduce}
              />
            )
          })}

          {/* summing junction: the shift and spread blocks add into the cleared cover spectrum */}
          <circle cx={SIGMA.cx} cy={SIGMA.cy} r={SIGMA.r} fill="#0b1220" stroke={sumState === 'done' ? '#fbbf24' : '#334155'} strokeWidth={2} />
          <text x={SIGMA.cx} y={SIGMA.cy + 7} textAnchor="middle" fontSize={22} className={sumState === 'done' ? 'fill-amber-300' : 'fill-slate-500'}>
            Σ
          </text>

          <Terminal x={col(10)} y={ROW.cover} title="stego.wav" sub={outState === 'done' ? 'ready' : 'not yet'} lit={outState === 'done'} output />
        </svg>
      </div>

      {/* Narrow screens: the same blocks as an ordered list */}
      <ol className="space-y-1.5 lg:hidden" aria-label="Encoder blocks in execution order">
        {ENCODE_RUN_STAGES.map((stage, i) => {
          const st = state(stage)
          const e = progress[stage]
          return (
            <li
              key={stage}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2 ring-1 transition-colors',
                st === 'running' ? 'bg-cyan-400/10 ring-cyan-400/50' : st === 'done' ? 'bg-white/[0.03] ring-cyan-400/20' : st === 'failed' ? 'bg-rose-500/10 ring-rose-400/40' : 'ring-white/10',
                st === 'skipped' && 'opacity-50',
              )}
            >
              <span className="w-5 shrink-0 text-right font-mono text-[11px] text-slate-500">{i + 1}</span>
              <StateIcon state={st} />
              <span className="min-w-0 grow">
                <span className="block truncate text-sm font-medium text-white">{STAGE_INFO[stage].title}</span>
                <span className="block truncate font-mono text-[11px] text-slate-400">{stage === 'fft' ? fftSub : STAGE_INFO[stage].sub}</span>
              </span>
              <span className={cn('shrink-0 font-mono text-[11px]', st === 'done' ? 'text-cyan-200' : st === 'failed' ? 'text-rose-300' : 'text-slate-500')}>
                {st === 'done' && e?.ms != null ? fmtMs(e.ms) : statusLine(st, e)}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ariaSummary(progress: Partial<Record<EncodeRunStage, StageEvent>>, failed: boolean): string {
  const parts = ENCODE_RUN_STAGES.filter((s) => s !== 'analysis').map((s) => `${STAGE_INFO[s].title}: ${blockState(progress, s, failed)}`)
  return `Encoder block diagram. ${parts.join(', ')}.`
}

function StateIcon({ state }: { state: BlockState }) {
  if (state === 'running') return <Loader2 className="size-4 shrink-0 animate-spin text-cyan-300 motion-reduce:animate-none" aria-label="running" />
  if (state === 'done') return <Check className="size-4 shrink-0 text-cyan-300" aria-label="done" />
  if (state === 'skipped') return <MinusCircle className="size-4 shrink-0 text-slate-500" aria-label="skipped" />
  if (state === 'failed') return <CircleX className="size-4 shrink-0 text-rose-400" aria-label="failed" />
  return <CircleDashed className="size-4 shrink-0 text-slate-600" aria-label="waiting" />
}

function SchematicBlock({ x, y, h, title, sub, status, state, reduce }: { x: number; y: number; h: number; title: string; sub: string; status: string; state: BlockState; reduce: boolean }) {
  const stroke = STROKE[state]
  const cy = y + h / 2
  return (
    <g opacity={state === 'skipped' ? 0.45 : state === 'waiting' ? 0.7 : 1}>
      {state === 'running' && !reduce && (
        <motion.rect
          x={x - 4}
          y={y - 4}
          width={W + 8}
          height={h + 8}
          rx={11}
          fill="none"
          stroke="#22d3ee"
          strokeWidth={2}
          initial={{ opacity: 0.2 }}
          animate={{ opacity: [0.2, 0.9, 0.2] }}
          transition={{ duration: 0.9, repeat: Infinity }}
        />
      )}
      <rect
        x={x}
        y={y}
        width={W}
        height={h}
        rx={8}
        fill={state === 'running' ? '#0e2a33' : '#0b1220'}
        stroke={stroke}
        strokeWidth={state === 'waiting' || state === 'skipped' ? 1.4 : 2}
        strokeDasharray={state === 'skipped' ? '5 4' : undefined}
      />
      <text x={x + W / 2} y={cy - 12} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-white">
        {title}
      </text>
      <text x={x + W / 2} y={cy + 4} textAnchor="middle" fontSize={10.5} className="fill-slate-400 font-mono">
        {sub}
      </text>
      <text
        x={x + W / 2}
        y={cy + 21}
        textAnchor="middle"
        fontSize={11.5}
        className={cn('font-mono', state === 'done' ? 'fill-cyan-200' : state === 'running' ? 'fill-cyan-300' : state === 'failed' ? 'fill-rose-300' : 'fill-slate-500')}
      >
        {status}
      </text>
    </g>
  )
}

function Terminal({ x, y, title, sub, lit, dim, output }: { x: number; y: number; title: string; sub: string; lit: boolean; dim?: boolean; output?: boolean }) {
  const stroke = lit ? (output ? '#34d399' : '#94a3b8') : '#334155'
  return (
    <g opacity={dim ? 0.4 : 1}>
      <rect x={x} y={y} width={W} height={H} rx={H / 2} fill="#0b1220" stroke={stroke} strokeWidth={lit ? 2 : 1.4} strokeDasharray={dim ? '5 4' : undefined} />
      <text x={x + W / 2} y={y + H / 2 - 3} textAnchor="middle" fontSize={14} fontWeight={600} className={lit && output ? 'fill-emerald-300' : 'fill-white'}>
        {title}
      </text>
      <text x={x + W / 2} y={y + H / 2 + 15} textAnchor="middle" fontSize={11} className="fill-slate-400 font-mono">
        {dim ? 'not sent' : sub}
      </text>
    </g>
  )
}

/** Measured time per block as one proportional bar, plus totals. */
export function RunTimeline({ progress }: { progress: Partial<Record<EncodeRunStage, StageEvent>> }) {
  const done = ENCODE_RUN_STAGES.map((s) => progress[s]).filter((e): e is StageEvent => !!e && e.status === 'done' && e.ms != null)
  if (done.length === 0) return null
  const total = done.reduce((a, e) => a + (e.ms ?? 0), 0)
  const encoderMs = done.filter((e) => e.stage !== 'analysis').reduce((a, e) => a + (e.ms ?? 0), 0)
  const analysis = progress.analysis?.status === 'done' ? (progress.analysis.ms ?? 0) : null
  const palette = ['#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#60a5fa', '#f472b6', '#2dd4bf', '#c084fc', '#facc15', '#38bdf8', '#fb923c', '#64748b']
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <span className="font-medium text-slate-300">Measured time per block</span>
        <span className="font-mono text-slate-400">
          encoder {fmtMs(encoderMs)}
          {analysis !== null && ` · display analysis ${fmtMs(analysis)}`}
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/5" role="img" aria-label={`Encoder took ${fmtMs(encoderMs)} in total`}>
        {done.map((e) => (
          <div
            key={e.stage}
            title={`${STAGE_INFO[e.stage].title}: ${fmtMs(e.ms ?? 0)}`}
            style={{ width: `${((e.ms ?? 0) / total) * 100}%`, background: palette[ENCODE_RUN_STAGES.indexOf(e.stage)] }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400">
        {done.map((e) => (
          <li key={e.stage} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm" style={{ background: palette[ENCODE_RUN_STAGES.indexOf(e.stage)] }} />
            {STAGE_INFO[e.stage].title} {fmtMs(e.ms ?? 0)}
          </li>
        ))}
      </ul>
    </div>
  )
}
