import { motion } from 'motion/react'
import { useMemo, type ReactNode } from 'react'
import { welchPsd } from '../../dsp/analysis'
import { SAMPLE_RATE } from '../../dsp/constants'
import type { BandLayout } from '../../dsp/spectral-ops'
import type { PipelineNode } from '../../pipeline/stage-meta'
import type { StageView } from '../../worker/protocol'
import { WaveformPlayer } from '../audio/waveform-player'
import { LineChart, type ChartBand } from '../charts/line-chart'
import { SpectrogramCanvas } from '../charts/spectrogram-canvas'
import { Badge, Card } from '../ui/primitives'

export function bandsFor(layout: BandLayout): ChartBand[] {
  const lo = layout.baseLow * layout.binHz
  const hi = (layout.baseLow + layout.width) * layout.binHz
  const clo = layout.carrierLow * layout.binHz
  return [
    { from: lo, to: hi, color: '#a78bfa', label: 'speech band' },
    { from: clo, to: clo + (hi - lo), color: '#22d3ee', label: 'carrier band' },
  ]
}

export function marksFor(layout: BandLayout) {
  const clo = layout.carrierLow * layout.binHz
  return [
    { hz: clo, label: `${(clo / 1000).toFixed(1)} kHz`, color: '#22d3ee' },
    { hz: clo + layout.width * layout.binHz, label: '', color: '#22d3ee' },
  ]
}

/**
 * Detail PSD used when the spectrum is shown on its own: 75 % overlap and many more averaged
 * segments than the worker's quick preview, so the trace is smooth enough to read at full width.
 * ~13 ms per signal, memoised per stage.
 */
const DETAIL_NFFT = 2048
const DETAIL_OVERLAP = 0.75
const DETAIL_FRAMES = 400

interface StageInspectorProps<S extends string> {
  node: PipelineNode<S>
  views: Record<S, StageView>
  layout: BandLayout
  extra?: ReactNode
  /** Drop the spectrogram and give the full width to a larger, finer power spectrum. */
  spectrumOnly?: boolean
}

export function StageInspector<S extends string>({ node, views, layout, extra, spectrumOnly = false }: StageInspectorProps<S>) {
  const stageView = node.stage ? views[node.stage] : null
  const beforeView = node.before ? views[node.before] : null

  const detail = useMemo(() => {
    if (!spectrumOnly || !stageView) return null
    return {
      output: welchPsd(stageView.samples, SAMPLE_RATE, DETAIL_NFFT, DETAIL_OVERLAP, DETAIL_FRAMES),
      input: beforeView ? welchPsd(beforeView.samples, SAMPLE_RATE, DETAIL_NFFT, DETAIL_OVERLAP, DETAIL_FRAMES) : null,
    }
  }, [spectrumOnly, stageView, beforeView])

  if (!node.stage || !stageView) {
    return (
      <motion.div key={node.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <Card className="space-y-5">
          <InspectorHeader node={node} />
          {extra}
        </Card>
      </motion.div>
    )
  }
  const view = stageView
  const before = beforeView
  const inputPsd = detail?.input ?? before?.psd ?? null
  const outputPsd = detail?.output ?? view.psd
  const series = [
    ...(inputPsd ? [{ x: inputPsd.freqs, y: inputPsd.db, color: '#64748b', label: 'input of this block', dashed: true }] : []),
    { x: outputPsd.freqs, y: outputPsd.db, color: '#22d3ee', label: 'output of this block' },
  ]

  return (
    <motion.div key={node.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <Card className="space-y-5">
        <InspectorHeader node={node} />

        <WaveformPlayer
          samples={view.samples}
          normalize={node.normalize}
          label={node.normalize ? 'Listen to this stage (loudness normalised)' : 'Listen to this stage'}
          color={node.kind === 'output' ? 'emerald' : node.kind === 'fft' ? 'violet' : 'cyan'}
        />

        {extra}

        {spectrumOnly ? (
          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="text-sm font-medium text-slate-200">Power spectrum</div>
              <div className="font-mono text-[11px] text-slate-500">
                Welch · {DETAIL_NFFT}-pt Hann · {DETAIL_OVERLAP * 100}% overlap · {(SAMPLE_RATE / DETAIL_NFFT).toFixed(1)} Hz per bin
              </div>
            </div>
            <LineChart
              series={series}
              bands={bandsFor(layout)}
              xDomain={[0, 22050]}
              height={340}
              yRange={110}
              xTicks={11}
              yTicks={8}
              fill
              strokeWidth={1.6}
              xFormat={(v) => (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}
            />
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium text-slate-300">Power spectrum (Welch PSD)</div>
              <LineChart series={series} bands={bandsFor(layout)} xDomain={[0, 22050]} />
            </div>
            <SpectrogramCanvas spec={view.spec} title="Spectrogram" marks={marksFor(layout)} height={200} />
          </div>
        )}
      </Card>
    </motion.div>
  )
}

function InspectorHeader<S extends string>({ node }: { node: PipelineNode<S> }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-white">{node.title}</h3>
          <Badge>{node.subtitle}</Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">{node.theory}</p>
      </div>
      {node.formula && (
        <div className="rounded-xl bg-violet-500/10 px-4 py-3 font-mono text-sm text-violet-200 ring-1 ring-violet-400/30">{node.formula}</div>
      )}
    </div>
  )
}
