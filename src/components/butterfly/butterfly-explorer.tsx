import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { dft, traceFft, type FftKind } from '../../dsp/fft'
import { Badge, Card, CardTitle, Segmented } from '../ui/primitives'
import { ButterflyDiagram, flatten, fmtComplex } from './butterfly-diagram'

interface ButterflyExplorerProps {
  received: Float32Array
  initialKind: FftKind
  stats: { fftSize: number; fftStages: number; butterflyCount: number; fftMs: number; kind: FftKind }
  /** Called once, when the animation has executed every butterfly. */
  onFinished?: () => void
}

/** Time each butterfly stays highlighted while the animation plays by itself. */
const STEP_MS: Record<8 | 16, number> = { 8: 650, 16: 380 }

function loudestOffset(x: Float32Array, n: number): number {
  let best = 0
  let idx = 0
  for (let i = 0; i < x.length - n; i += 64) {
    const a = Math.abs(x[i])
    if (a > best) {
      best = a
      idx = i
    }
  }
  return idx
}

const fmtInt = (v: number) => v.toLocaleString('en-US')

/**
 * Zoom on the decoder's FFT: a few real received samples run through the same `fft()` code, one
 * butterfly at a time. It plays by itself from the first butterfly to the last.
 */
export function ButterflyExplorer({ received, initialKind, stats, onFinished }: ButterflyExplorerProps) {
  const [n, setN] = useState<8 | 16>(8)
  const [kind, setKind] = useState<FftKind>(initialKind)
  // the loudest stretch of the file, so the numbers are not all near zero
  const offset = useMemo(() => loudestOffset(received, 16), [received])
  const [cursor, setCursor] = useState(0)
  const finishedOnce = useRef(false)
  const speed = STEP_MS[n]

  const input = useMemo(() => Array.from(received.subarray(offset, offset + n)), [received, offset, n])
  const trace = useMemo(() => traceFft(input, kind), [input, kind])
  const flat = useMemo(() => flatten(trace), [trace])
  const total = flat.length
  const done = cursor >= total

  // a new zoom (DIT/DIF or N) starts again from the first butterfly
  useEffect(() => {
    setCursor(0)
  }, [trace])

  useEffect(() => {
    if (cursor >= total) {
      if (!finishedOnce.current) {
        finishedOnce.current = true
        onFinished?.()
      }
      return
    }
    const t = setTimeout(() => setCursor((c) => c + 1), speed)
    return () => clearTimeout(t)
  }, [cursor, total, speed, onFinished])

  const current = cursor < total ? flat[cursor] : null
  const inCol = current ? trace.columns[current.stage] : null
  const outCol = current ? trace.columns[current.stage + 1] : null

  const verifyErr = useMemo(() => {
    const ref = dft(input, new Array(n).fill(0))
    const last = trace.columns[trace.columns.length - 1]
    let e = 0
    trace.outputOrder.forEach((k, slot) => {
      e = Math.max(e, Math.hypot(last.re[slot] - ref.re[k], last.im[slot] - ref.im[k]))
    })
    return e
  }, [trace, input, n])

  const spectrum = useMemo(() => {
    const last = trace.columns[trace.columns.length - 1]
    const mags = new Array<number>(n).fill(0)
    trace.outputOrder.forEach((k, slot) => (mags[k] = Math.hypot(last.re[slot], last.im[slot])))
    return mags
  }, [trace, n])
  const magMax = Math.max(...spectrum, 1e-9)

  const N = stats.fftSize
  const directOps = N * N
  const speedup = directOps / stats.butterflyCount

  return (
    <div className="space-y-5">
      <Card>
        <CardTitle
          title={`Radix-2 ${kind.toUpperCase()} butterfly — ${n}-point zoom`}
          hint={`Real samples x[${offset}…${offset + n - 1}] from the received audio, run through the decoder's own FFT routine.`}
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'dit', label: 'DIT' },
                  { value: 'dif', label: 'DIF' },
                ]}
              />
              <Segmented
                value={String(n) as '8' | '16'}
                onChange={(v) => setN(Number(v) as 8 | 16)}
                options={[
                  { value: '8', label: 'N = 8' },
                  { value: '16', label: 'N = 16' },
                ]}
              />
            </div>
          }
        />

        <ButterflyDiagram trace={trace} cursor={cursor} onPick={(f) => setCursor(f)} />

        <div className="mt-4 flex items-center gap-3" aria-live="off">
          <div className="h-1.5 grow overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(cursor, total)} aria-label="Butterflies executed">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-400 transition-[width] duration-300" style={{ width: `${(Math.min(cursor, total) / total) * 100}%` }} />
          </div>
          <span className="shrink-0 font-mono text-[11px] text-slate-400">
            {done ? 'complete' : `butterfly ${cursor + 1} / ${total}`}
          </span>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardTitle title="Current butterfly" hint={`${Math.min(cursor, total)} / ${total} butterflies executed`} />
          <AnimatePresence mode="wait">
            {current && inCol && outCol ? (
              <motion.div
                key={current.flat}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.15 }}
                className="space-y-3 font-mono text-[13px]"
              >
                <div className="flex flex-wrap gap-2">
                  <Badge>stage {current.stage + 1}</Badge>
                  <Badge>
                    wings {current.top} ↔ {current.bottom}
                  </Badge>
                  <Badge className="text-violet-300">
                    W<sub>{n}</sub>
                    <sup>{current.k}</sup> = {fmtComplex(Math.cos((2 * Math.PI * current.k) / n), -Math.sin((2 * Math.PI * current.k) / n), 3)}
                  </Badge>
                </div>
                <div className="rounded-xl bg-black/30 p-4 leading-7 ring-1 ring-white/10">
                  <div>
                    a = <span className="text-cyan-300">{fmtComplex(inCol.re[current.top], inCol.im[current.top], 4)}</span>
                  </div>
                  <div>
                    b = <span className="text-cyan-300">{fmtComplex(inCol.re[current.bottom], inCol.im[current.bottom], 4)}</span>
                  </div>
                  <div className="my-2 border-t border-white/10" />
                  {kind === 'dit' ? (
                    <>
                      <div>
                        a′ = a + W·b = <span className="text-amber-300">{fmtComplex(outCol.re[current.top], outCol.im[current.top], 4)}</span>
                      </div>
                      <div>
                        b′ = a − W·b = <span className="text-amber-300">{fmtComplex(outCol.re[current.bottom], outCol.im[current.bottom], 4)}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        a′ = a + b = <span className="text-amber-300">{fmtComplex(outCol.re[current.top], outCol.im[current.top], 4)}</span>
                      </div>
                      <div>
                        b′ = (a − b)·W = <span className="text-amber-300">{fmtComplex(outCol.re[current.bottom], outCol.im[current.bottom], 4)}</span>
                      </div>
                    </>
                  )}
                </div>
                <p className="font-sans text-xs leading-relaxed text-slate-400">
                  {kind === 'dit'
                    ? 'Decimation in time: the input is split into even/odd samples recursively, so it enters in bit-reversed order. The twiddle multiplies the lower wing before the add/subtract.'
                    : 'Decimation in frequency: the output is split into even/odd frequencies recursively. Inputs enter in natural order, the twiddle multiplies after the subtract, and outputs come out bit-reversed.'}
                </p>
              </motion.div>
            ) : (
              <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
                <div className="text-sm text-emerald-300">All {total} butterflies done — this column is the DFT X[k].</div>
                <div className="flex h-28 items-end gap-1.5">
                  {spectrum.map((m, k) => (
                    <div key={k} className="flex flex-1 flex-col items-center gap-1">
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${(m / magMax) * 88}px` }}
                        className="w-full rounded-t bg-gradient-to-t from-emerald-500 to-cyan-300"
                      />
                      <span className="font-mono text-[9px] text-slate-500">{k}</span>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-slate-400">
                  |X[k]| · check against the direct DFT: max error{' '}
                  <span className="font-mono text-emerald-300">{verifyErr.toExponential(1)}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>

        <Card>
          <CardTitle title="The real decoding FFT" hint="Same function, full size — this is what extracted the hidden band." />
          <div className="grid grid-cols-2 gap-3 font-mono">
            <Stat label="N (zero-padded)" value={`2^${stats.fftStages} = ${fmtInt(N)}`} />
            <Stat label="algorithm" value={`radix-2 ${stats.kind.toUpperCase()}`} />
            <Stat label="stages × butterflies" value={`${stats.fftStages} × ${fmtInt(N / 2)}`} />
            <Stat label="total butterflies" value={fmtInt(stats.butterflyCount)} />
            <Stat label="time in browser" value={`${stats.fftMs.toFixed(1)} ms`} />
            <Stat label="vs direct DFT (N²)" value={`${speedup.toFixed(0)}× fewer ops`} />
          </div>
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] text-slate-400">Butterfly span per stage (distance between the two wings)</div>
            <div className="space-y-[3px]">
              {Array.from({ length: stats.fftStages }, (_, s) => {
                const span = stats.kind === 'dit' ? 2 ** s : N / 2 ** (s + 1)
                return (
                  <div key={s} className="flex items-center gap-2">
                    <span className="w-6 text-right font-mono text-[9px] text-slate-500">{s + 1}</span>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${((Math.log2(span) + 1) / stats.fftStages) * 100}%` }}
                      transition={{ delay: s * 0.03 }}
                      className="h-2 rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
                    />
                    <span className="font-mono text-[9px] text-slate-500">{fmtInt(span)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2 ring-1 ring-white/10">
      <div className="font-sans text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm text-cyan-200">{value}</div>
    </div>
  )
}
