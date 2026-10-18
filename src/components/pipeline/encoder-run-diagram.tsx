import { Check, ChevronLeft, ChevronRight, CircleDashed, CircleX, Loader2, MinusCircle, Pause, Play, RotateCcw } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { CARRIER_LOW_HZ, CHIPS_PER_BIT, GUARD_HZ, LANE_HIGH_HZ, LANE_LOW_HZ, NUM_SUBBANDS, SECRET_HIGH_HZ, SECRET_LOW_HZ } from '../../dsp/constants'
import { ENCODE_RUN_STAGES, type EncodeRunStage, type StageEvent } from '../../dsp/stego'
import { Button, cn } from '../ui/primitives'

/**
 * Encoder block diagram, played step by step.
 *
 * Every block is one piece of code in `encode()` (or the AES step in the worker before it), in the
 * order it really executes. The worker streams each block's start, end and measured time; the playback
 * then walks through those real events one block at a time, slowly enough to follow. It never runs
 * ahead of the encoder: a block is shown finished only after the worker reported it finished, and the
 * time printed on it is the one the worker measured.
 */

export type BlockState = 'waiting' | 'active' | 'done' | 'skipped' | 'failed'

/** The encoder's blocks in execution order ('analysis' is chart work, not encoding). */
export const PLAY_STAGES = ENCODE_RUN_STAGES.filter((s) => s !== 'analysis')
type PlayStage = (typeof PLAY_STAGES)[number]

const kHz = (hz: number) => (hz / 1000).toFixed(1)
const CARRIER_HIGH_HZ = CARRIER_LOW_HZ + SECRET_HIGH_HZ - SECRET_LOW_HZ + 2 * GUARD_HZ

export const STAGE_INFO: Record<EncodeRunStage, { title: string; sub: string; detail: string; formula?: string }> = {
  aes: {
    title: 'AES-256-GCM',
    sub: 'encrypt + frame',
    detail:
      'The key is stretched with PBKDF2-SHA256 and the text is encrypted with AES-256-GCM. With no text, an empty message is encrypted instead, so the receiver can still check the key. A sync byte and the length go in front.',
    formula: 'frame = salt ‖ IV ‖ AES-GCM_K(text) ‖ tag',
  },
  fft: {
    title: 'FFT',
    sub: 'two-for-one',
    detail:
      'One complex radix-2 FFT of z[n] = x_s[n] + j·x_c[n] gives the spectra of the secret and the cover at once, separated by Hermitian symmetry. From here on every block works on FFT bins.',
    formula: 'X[k] = Σ x[n]·e^{−j2πnk/N}',
  },
  fir: {
    title: 'FIR band-pass',
    sub: `${SECRET_LOW_HZ}–${SECRET_HIGH_HZ} Hz`,
    detail: 'A 1023-tap Hamming windowed-sinc band-pass keeps telephone-band speech. In the frequency domain the filter is a product of spectra (fast convolution); its group delay is removed afterwards.',
    formula: 'Y[k] = X_s[k]·H[k]',
  },
  reverse: {
    title: 'Time reversal',
    sub: 'X* · phase ramp',
    detail: 'The voice is played backwards without leaving the frequency domain: for a real signal, reversing time conjugates the spectrum and adds a linear phase.',
    formula: 'x[L−1−n] ⟷ X*[k]·e^{−j2πk(L−1)/N}',
  },
  invert: {
    title: 'Spectral inversion',
    sub: 'f → f_lo+f_hi−f',
    detail: 'Inside the speech band low frequencies become high and high become low, the classic analogue voice scrambler.',
    formula: 'Y[k] = X*[k_lo + k_hi − k]',
  },
  permute: {
    title: 'Keyed permutation',
    sub: `${NUM_SUBBANDS} sub-bands · key`,
    detail: `The band is cut into ${NUM_SUBBANDS} sub-bands and shuffled with a Fisher–Yates permutation seeded by the key: one of ${NUM_SUBBANDS}! ≈ 2×10¹³ orders.`,
    formula: 'Y_i = X_{π_key(i)}',
  },
  bandstop: {
    title: 'Band-stop cover',
    sub: 'zero hidden bins',
    detail: 'The cover bins where the hidden lanes will go are set to zero, so the cover cannot collide with them. Very little music lives up there, so the change is hard to hear.',
    formula: 'C[k] = 0,  k ∈ hidden bands',
  },
  shift: {
    title: 'Shift + scale',
    sub: `→ ${kHz(CARRIER_LOW_HZ)}–${kHz(CARRIER_HIGH_HZ)} kHz`,
    detail: 'The scrambled band is scaled to sit the chosen number of dB below the cover and moved up to the carrier band, where hearing is weakest. The mirror bins keep the signal real.',
    formula: 'S[k + Δk] = g·Y[k],  S[N−k] = S*[k]',
  },
  spread: {
    title: 'BPSK spreading',
    sub: `→ ${kHz(LANE_LOW_HZ)}–${kHz(LANE_HIGH_HZ)} kHz`,
    detail: `Each bit of the frame is phase-coded (0 → +A, 1 → −A) onto ${CHIPS_PER_BIT} bins, each multiplied by a key-seeded ±1 chip: direct-sequence spread spectrum above 20 kHz.`,
    formula: 'X[k₀+16i+c] = A·(−1)^{bᵢ}·chip_{16i+c}',
  },
  ifft: {
    title: 'Inverse FFT',
    sub: 'Σ → back to time',
    detail: 'The cleared cover, the shifted voice and the text lane are summed bin by bin, and the inverse FFT turns the sum back into a waveform.',
    formula: 's[n] = IFFT{ C[k] + S[k] + T[k] }',
  },
  limit: {
    title: 'Peak limit',
    sub: 'never clips',
    detail: 'If the sum peaks above 0.99 the whole file is scaled down by one factor, so the 16-bit WAV never clips and the hidden bands keep their shape.',
    formula: 's[n] ← s[n]·min(1, 0.99 / max|s|)',
  },
  analysis: { title: 'Display analysis', sub: 'PSD + spectrograms', detail: 'Spectra for the charts. Not part of the encoder.' },
}

const SKIP_REASON: Partial<Record<EncodeRunStage, string>> = {
  fir: 'Skipped: no voice in this run.',
  reverse: 'Skipped: no voice in this run.',
  invert: 'Skipped: no voice in this run.',
  permute: 'Skipped: no voice in this run.',
  shift: 'Skipped: no voice in this run.',
  spread: 'Skipped: nothing to send in the text lane.',
}

/** How long each block stays on screen while playing. */
const STEP_MS = 1700
const SKIP_MS = 650

const fmtMs = (ms: number) => (ms < 1 ? `${ms.toFixed(2)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`)
const finishedEvent = (e?: StageEvent) => !!e && e.status !== 'running'

export interface Playback {
  /** Index into PLAY_STAGES of the block on screen; PLAY_STAGES.length once the run is complete. */
  cursor: number
  playing: boolean
  /** Blocks the worker has finished so far (the playback can never pass this). */
  available: number
  complete: boolean
  toggle: () => void
  next: () => void
  back: () => void
  replay: () => void
  jump: (i: number) => void
}

/**
 * Walks through the real run one block at a time. A new run (empty progress) restarts it; it waits
 * whenever it catches up with the encoder.
 */
export function useRunPlayback(progress: Partial<Record<EncodeRunStage, StageEvent>>): Playback {
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(true)
  const fresh = Object.keys(progress).length === 0

  let available = 0
  while (available < PLAY_STAGES.length && finishedEvent(progress[PLAY_STAGES[available]])) available++

  useEffect(() => {
    if (fresh) {
      setCursor(0)
      setPlaying(true)
    }
  }, [fresh])

  const current = PLAY_STAGES[cursor] as PlayStage | undefined
  const currentEvent = current ? progress[current] : undefined
  useEffect(() => {
    if (!playing || cursor >= PLAY_STAGES.length || !finishedEvent(currentEvent)) return
    const t = setTimeout(() => setCursor((c) => c + 1), currentEvent?.status === 'skipped' ? SKIP_MS : STEP_MS)
    return () => clearTimeout(t)
  }, [playing, cursor, currentEvent])

  return {
    cursor,
    playing,
    available,
    complete: cursor >= PLAY_STAGES.length,
    toggle: () => {
      if (cursor >= PLAY_STAGES.length) {
        setCursor(0)
        setPlaying(true)
      } else setPlaying((p) => !p)
    },
    next: () => {
      setPlaying(false)
      setCursor((c) => Math.min(c + 1, available))
    },
    back: () => {
      setPlaying(false)
      setCursor((c) => Math.max(0, c - 1))
    },
    replay: () => {
      setCursor(0)
      setPlaying(true)
    },
    jump: (i) => {
      setPlaying(false)
      setCursor(Math.max(0, Math.min(i, available)))
    },
  }
}

function displayState(i: number, cursor: number, progress: Partial<Record<EncodeRunStage, StageEvent>>, failed: boolean): BlockState {
  const e = progress[PLAY_STAGES[i]]
  if (i < cursor) return e?.status === 'skipped' ? 'skipped' : 'done'
  if (i === cursor) {
    if (failed && e?.status === 'running') return 'failed'
    if (e?.status === 'skipped') return 'skipped'
    return e ? 'active' : 'waiting'
  }
  return 'waiting'
}

// ----- schematic geometry (SVG user units) -------------------------------------------------------
const W = 128
const H = 68
const COL = 144
const X0 = 12
const ROW = { voice: 34, cover: 164, text: 294 }
const col = (i: number) => X0 + i * COL
const SIGMA = { cx: col(7) + 50, cy: ROW.cover + H / 2, r: 22 }

type Pos = { x: number; y: number; h?: number }
const POS: Record<PlayStage, Pos> = {
  aes: { x: col(1), y: ROW.text },
  fft: { x: col(1), y: ROW.voice, h: ROW.cover + H - ROW.voice },
  fir: { x: col(2), y: ROW.voice },
  reverse: { x: col(3), y: ROW.voice },
  invert: { x: col(4), y: ROW.voice },
  permute: { x: col(5), y: ROW.voice },
  bandstop: { x: col(4), y: ROW.cover },
  shift: { x: col(6), y: ROW.voice },
  spread: { x: col(6), y: ROW.text },
  ifft: { x: col(8), y: ROW.cover },
  limit: { x: col(9), y: ROW.cover },
}
const VIEW_W = col(10) + W + 12
const VIEW_H = ROW.text + H + 16
const midY = (y: number) => y + H / 2

type WireEnd = PlayStage | 'input' | 'sigma' | 'output'
const WIRES: { id: string; from: WireEnd; to: WireEnd; points: [number, number][]; label?: string }[] = [
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

/** Polyline length, so a dot can travel along bends at constant speed. */
function pathOf(points: [number, number][]) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ')
}

interface DiagramProps {
  progress: Partial<Record<EncodeRunStage, StageEvent>>
  failed: boolean
  error?: string | null
  fftSize?: number | null
  playback: Playback
  /** True when no text was typed: the text lane then carries only the AES-GCM key-check token. */
  keyCheckOnly?: boolean
}

export function EncoderRunDiagram({ progress, failed, error, fftSize, playback, keyCheckOnly }: DiagramProps) {
  const reduce = !!useReducedMotion()
  const { cursor } = playback
  const states = useMemo(() => {
    const out = {} as Record<PlayStage, BlockState>
    PLAY_STAGES.forEach((s, i) => (out[s] = displayState(i, cursor, progress, failed)))
    return out
  }, [cursor, progress, failed])
  const started = Object.keys(progress).length > 0
  const activeStage = cursor < PLAY_STAGES.length ? PLAY_STAGES[cursor] : null
  const finished = (s: PlayStage) => states[s] === 'done' || states[s] === 'skipped'
  const sumLit = finished('shift') && finished('bandstop') && finished('spread')
  const complete = playback.complete
  const voiceSkipped = progress.fir?.status === 'skipped'
  const fftSub = fftSize ? `N = 2^${Math.log2(fftSize)}` : STAGE_INFO.fft.sub

  const endLit = (end: WireEnd) => (end === 'input' ? started : end === 'sigma' ? sumLit : end === 'output' ? complete : states[end] === 'done')
  const endSkipped = (end: WireEnd) => end !== 'input' && end !== 'sigma' && end !== 'output' && states[end] === 'skipped'
  const feedsActive = (to: WireEnd) => activeStage !== null && to === activeStage && states[activeStage] === 'active'
  // the Σ is part of the inverse-FFT step: light its inputs while that step runs
  const feedsSum = (to: WireEnd) => to === 'sigma' && activeStage === 'ifft' && states.ifft === 'active'

  return (
    <div className="space-y-4">
      {/* Wide screens: the schematic */}
      <div className="hidden overflow-hidden rounded-2xl bg-black/25 p-3 ring-1 ring-white/10 lg:block">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-auto w-full" role="img" aria-label={ariaSummary(states, complete)}>
          <defs>
            <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
            <filter id="erd-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {[
            ['voice lane', ROW.voice - 12],
            ['cover', ROW.cover - 12],
            ['text lane', ROW.text - 12],
          ].map(([label, y]) => (
            <text key={label} x={X0} y={y} className="fill-slate-500 font-mono" fontSize={12} letterSpacing={1.5}>
              {String(label).toUpperCase()}
            </text>
          ))}

          {WIRES.map((w) => {
            const lit = endLit(w.from)
            const skipped = endSkipped(w.from) || endSkipped(w.to)
            const flowing = feedsActive(w.to) || feedsSum(w.to)
            const first = w.points[0]
            const last = w.points[w.points.length - 1]
            const d = pathOf(w.points)
            return (
              <g key={w.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={lit && !skipped ? '#22d3ee' : '#334155'}
                  strokeOpacity={lit && !skipped ? 0.85 : 1}
                  strokeWidth={lit && !skipped ? 2.2 : 1.6}
                  strokeDasharray={skipped ? '5 5' : undefined}
                  markerEnd="url(#erd-arrow)"
                />
                {/* signal flowing into the block that is processing right now */}
                {flowing && !reduce && (
                  <>
                    <motion.path
                      d={d}
                      fill="none"
                      stroke="#a5f3fc"
                      strokeWidth={3}
                      strokeDasharray="6 14"
                      initial={{ strokeDashoffset: 0 }}
                      animate={{ strokeDashoffset: -40 }}
                      transition={{ duration: 0.6, repeat: Infinity, ease: 'linear' }}
                    />
                    <motion.circle
                      r={5}
                      fill="#ecfeff"
                      filter="url(#erd-glow)"
                      style={{ offsetPath: `path('${d}')` }}
                      initial={{ offsetDistance: '0%', opacity: 0 }}
                      animate={{ offsetDistance: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut' }}
                    />
                  </>
                )}
                {w.label && (
                  <text x={(first[0] + last[0]) / 2} y={first[1] - 8} textAnchor="middle" className="fill-slate-500 font-mono" fontSize={12}>
                    {w.label}
                  </text>
                )}
              </g>
            )
          })}

          <Terminal x={col(0)} y={ROW.voice} title="Secret voice" sub="x_s[n]" lit={started && !voiceSkipped} dim={voiceSkipped} />
          <Terminal x={col(0)} y={ROW.cover} title="Cover" sub="x_c[n]" lit={started} />
          <Terminal x={col(0)} y={ROW.text} title={keyCheckOnly ? 'Key check' : 'Hidden text'} sub={keyCheckOnly ? 'empty text' : 'UTF-8'} lit={started} />

          {PLAY_STAGES.map((stage) => {
            const p = POS[stage]
            const e = progress[stage]
            return (
              <SchematicBlock
                key={stage}
                x={p.x}
                y={p.y}
                h={p.h ?? H}
                title={STAGE_INFO[stage].title}
                sub={stage === 'fft' ? fftSub : STAGE_INFO[stage].sub}
                state={states[stage]}
                ms={states[stage] === 'done' ? e?.ms : undefined}
                dwellMs={STEP_MS}
                reduce={reduce}
              />
            )
          })}

          <g>
            {sumLit && !reduce && activeStage === 'ifft' && (
              <motion.circle
                cx={SIGMA.cx}
                cy={SIGMA.cy}
                r={SIGMA.r}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={2}
                initial={{ r: SIGMA.r, opacity: 0.8 }}
                animate={{ r: SIGMA.r + 14, opacity: 0 }}
                transition={{ duration: 1, repeat: Infinity }}
              />
            )}
            <circle cx={SIGMA.cx} cy={SIGMA.cy} r={SIGMA.r} fill="#0b1220" stroke={sumLit ? '#fbbf24' : '#334155'} strokeWidth={2} />
            <text x={SIGMA.cx} y={SIGMA.cy + 7} textAnchor="middle" fontSize={22} className={sumLit ? 'fill-amber-300' : 'fill-slate-500'}>
              Σ
            </text>
          </g>

          <g>
            {complete && !reduce && (
              <motion.rect
                x={col(10)}
                y={ROW.cover}
                width={W}
                height={H}
                rx={H / 2}
                fill="none"
                stroke="#34d399"
                strokeWidth={2}
                initial={{ opacity: 0.9, scale: 1 }}
                animate={{ opacity: 0, scale: 1.25 }}
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                transition={{ duration: 1.2, repeat: 2 }}
              />
            )}
            <Terminal x={col(10)} y={ROW.cover} title="stego.wav" sub={complete ? 'ready' : 'not yet'} lit={complete} output />
          </g>
        </svg>
      </div>

      {/* Narrow screens: the same blocks as an ordered list */}
      <ol className="space-y-1.5 lg:hidden" aria-label="Encoder blocks in execution order">
        {PLAY_STAGES.map((stage, i) => {
          const st = states[stage]
          const e = progress[stage]
          return (
            <li
              key={stage}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2 ring-1 transition-colors duration-300',
                st === 'active' ? 'bg-cyan-400/10 ring-cyan-400/60' : st === 'done' ? 'bg-white/[0.03] ring-cyan-400/20' : st === 'failed' ? 'bg-rose-500/10 ring-rose-400/40' : 'ring-white/10',
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
                {st === 'done' && e?.ms != null ? fmtMs(e.ms) : st === 'active' ? 'processing…' : st === 'skipped' ? 'skipped' : st === 'failed' ? 'failed' : ''}
              </span>
            </li>
          )
        })}
      </ol>

      <StepCaption progress={progress} playback={playback} failed={failed} error={error} started={started} />
    </div>
  )
}

/** What the block on screen does, its measured time, and the playback controls. */
function StepCaption({
  progress,
  playback,
  failed,
  error,
  started,
}: {
  progress: Partial<Record<EncodeRunStage, StageEvent>>
  playback: Playback
  failed: boolean
  error?: string | null
  started: boolean
}) {
  const { cursor, complete, playing, available } = playback
  const stage = cursor < PLAY_STAGES.length ? PLAY_STAGES[cursor] : null
  const e = stage ? progress[stage] : undefined
  const info = stage ? STAGE_INFO[stage] : null
  const encoderMs = PLAY_STAGES.reduce((a, s) => a + (progress[s]?.ms ?? 0), 0)
  const waitingForEncoder = !!stage && !failed && !!started && !finishedEvent(e)

  return (
    <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={complete ? 'done' : `${cursor}-${failed}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
              {!started ? (
                <>
                  <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-slate-400">Not started</div>
                  <p className="mt-1 text-sm text-slate-300">Start the encoder to watch it work block by block.</p>
                </>
              ) : failed && !complete ? (
                <>
                  <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-rose-300">Failed at step {cursor + 1}</div>
                  <h4 className="mt-1 text-sm font-semibold text-white">{info?.title}</h4>
                  <p className="mt-1 text-sm text-rose-200">{error}</p>
                </>
              ) : complete ? (
                <>
                  <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Complete</div>
                  <h4 className="mt-1 text-sm font-semibold text-white">stego.wav is ready</h4>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-300">
                    It sounds like the cover, but now carries the hidden payload. The encoder itself took {fmtMs(encoderMs)} in the Web Worker; the playback above
                    was slowed down so each step can be followed.
                  </p>
                </>
              ) : (
                <>
                  <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                    Step {cursor + 1} of {PLAY_STAGES.length}
                  </div>
                  <h4 className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                    {info?.title}
                    {e?.status === 'done' && e.ms != null && <span className="font-mono text-[11px] font-normal text-cyan-200">measured {fmtMs(e.ms)}</span>}
                  </h4>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-300">
                    {e?.status === 'skipped' ? SKIP_REASON[stage!] : waitingForEncoder ? 'The encoder is computing this block…' : info?.detail}
                  </p>
                  {info?.formula && e?.status !== 'skipped' && (
                    <div className="mt-2 inline-block rounded-lg bg-violet-500/10 px-3 py-1.5 font-mono text-xs text-violet-200 ring-1 ring-violet-400/30">{info.formula}</div>
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={playback.back} disabled={!started || cursor === 0} icon={<ChevronLeft className="size-4" />} aria-label="Previous step">
            Back
          </Button>
          <Button
            size="sm"
            onClick={playback.toggle}
            disabled={!started}
            icon={complete ? <RotateCcw className="size-4" /> : playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          >
            {complete ? 'Replay' : playing ? 'Pause' : 'Play'}
          </Button>
          <Button variant="secondary" size="sm" onClick={playback.next} disabled={!started || cursor >= available} icon={<ChevronRight className="size-4" />} aria-label="Next step">
            Next
          </Button>
        </div>
      </div>

      {/* one segment per block; finished ones can be revisited */}
      <div className="mt-4 flex gap-1" role="group" aria-label="Jump to a step">
        {PLAY_STAGES.map((s, i) => {
          const ev = progress[s]
          const reached = i < cursor || (complete && i < PLAY_STAGES.length)
          const isActive = i === cursor && !complete
          return (
            <button
              key={s}
              type="button"
              onClick={() => playback.jump(i)}
              disabled={i > available}
              title={STAGE_INFO[s].title}
              aria-label={`Step ${i + 1}: ${STAGE_INFO[s].title}`}
              aria-current={isActive ? 'step' : undefined}
              className={cn(
                'h-1.5 grow rounded-full transition-colors duration-300 disabled:cursor-default',
                isActive ? 'bg-cyan-300' : reached ? (ev?.status === 'skipped' ? 'bg-slate-600' : 'bg-cyan-500/70') : 'bg-white/10',
              )}
            />
          )
        })}
      </div>
    </div>
  )
}

function ariaSummary(states: Record<PlayStage, BlockState>, complete: boolean): string {
  const parts = PLAY_STAGES.map((s) => `${STAGE_INFO[s].title}: ${states[s]}`)
  return `Encoder block diagram${complete ? ', complete' : ''}. ${parts.join(', ')}.`
}

function StateIcon({ state }: { state: BlockState }) {
  if (state === 'active') return <Loader2 className="size-4 shrink-0 animate-spin text-cyan-300 motion-reduce:animate-none" aria-label="processing" />
  if (state === 'done') return <Check className="size-4 shrink-0 text-cyan-300" aria-label="done" />
  if (state === 'skipped') return <MinusCircle className="size-4 shrink-0 text-slate-500" aria-label="skipped" />
  if (state === 'failed') return <CircleX className="size-4 shrink-0 text-rose-400" aria-label="failed" />
  return <CircleDashed className="size-4 shrink-0 text-slate-600" aria-label="waiting" />
}

function SchematicBlock({
  x,
  y,
  h,
  title,
  sub,
  state,
  ms,
  dwellMs,
  reduce,
}: {
  x: number
  y: number
  h: number
  title: string
  sub: string
  state: BlockState
  ms?: number
  dwellMs: number
  reduce: boolean
}) {
  const active = state === 'active'
  const cy = y + h / 2
  const stroke = state === 'failed' ? '#fb7185' : state === 'done' || active ? '#22d3ee' : '#334155'
  const status = state === 'done' ? (ms != null ? `✓ ${fmtMs(ms)}` : '✓') : active ? 'processing…' : state === 'skipped' ? 'skipped' : state === 'failed' ? '✕ failed' : 'waiting'
  return (
    <motion.g
      initial={false}
      animate={{ opacity: state === 'skipped' ? 0.4 : state === 'waiting' ? 0.55 : 1 }}
      transition={{ duration: reduce ? 0 : 0.35 }}
    >
      {active && !reduce && (
        <motion.rect
          x={x - 5}
          y={y - 5}
          width={W + 10}
          height={h + 10}
          rx={12}
          fill="none"
          stroke="#22d3ee"
          strokeWidth={2.5}
          filter="url(#erd-glow)"
          initial={{ opacity: 0.25 }}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.1, repeat: Infinity }}
        />
      )}
      <rect
        x={x}
        y={y}
        width={W}
        height={h}
        rx={8}
        fill={active ? '#0c2b35' : state === 'done' ? '#0b1a24' : '#0b1220'}
        stroke={stroke}
        strokeWidth={state === 'waiting' || state === 'skipped' ? 1.4 : 2}
        strokeDasharray={state === 'skipped' ? '5 4' : undefined}
      />
      {/* processing sweep along the bottom edge while this block is on screen */}
      {active && (
        <motion.rect
          x={x + 8}
          y={y + h - 9}
          height={3}
          rx={1.5}
          fill="#22d3ee"
          initial={{ width: reduce ? W - 16 : 0 }}
          animate={{ width: W - 16 }}
          transition={{ duration: reduce ? 0 : dwellMs / 1000, ease: 'linear' }}
        />
      )}
      <text x={x + W / 2} y={cy - 12} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-white">
        {title}
      </text>
      <text x={x + W / 2} y={cy + 4} textAnchor="middle" fontSize={10.5} className="fill-slate-400 font-mono">
        {sub}
      </text>
      <motion.text
        key={state}
        x={x + W / 2}
        y={cy + 21}
        textAnchor="middle"
        fontSize={11.5}
        className={cn('font-mono', state === 'done' ? 'fill-cyan-200' : active ? 'fill-cyan-300' : state === 'failed' ? 'fill-rose-300' : 'fill-slate-500')}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        {status}
      </motion.text>
    </motion.g>
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
