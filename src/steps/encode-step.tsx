import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { LineChart } from '../components/charts/line-chart'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { PermutationView } from '../components/pipeline/permutation-view'
import { LaneStats } from '../components/text-lane/text-result'
import { BitGrid, CipherFrameView } from '../components/text-lane/text-lane-views'
import { PipelineFlow } from '../components/pipeline/pipeline-flow'
import { StageInspector } from '../components/pipeline/stage-inspector'
import { Button, Card, CardTitle } from '../components/ui/primitives'
import { ENCODE_EDGES, ENCODE_NODES } from '../pipeline/stage-meta'
import { useStegoStore } from '../store/use-stego-store'

const MAX_ORDER = Math.max(...ENCODE_NODES.map((n) => n.order))

/**
 * One entry per reveal level in ENCODE_NODES — a level can light several blocks at once, because the
 * voice, cover and text lanes advance in parallel. Index = the `order` value that step reveals.
 */
const STEP_GUIDE: { title: string; text: string }[] = [
  { title: 'The three inputs', text: 'The secret voice, the cover music and the optional hidden text enter the encoder, all as 44.1 kHz mono signals.' },
  { title: 'Band-limit the voice', text: 'A 1023-tap Hamming windowed-sinc FIR keeps only 300–3400 Hz of the speech, so it fits inside the narrow carrier band.' },
  { title: 'Reverse the voice, encrypt the text', text: 'The speech is played backwards — reversing time conjugates its spectrum — while the text is encrypted with AES-256-GCM.' },
  { title: 'Into the frequency domain', text: 'The clip is zero-padded to a power of two and transformed with the same radix-2 FFT the receiver will use to decode it.' },
  { title: 'Scramble and spread', text: 'Low and high frequencies swap places inside the speech band, and every text bit is BPSK phase-coded across 16 key-seeded chips.' },
  { title: 'Shuffle with the key', text: 'The speech band is cut into 16 sub-bands and shuffled by a key-derived Fisher–Yates permutation, one of 16! possible orders.' },
  { title: 'Make room, then move up', text: 'The scrambled band moves to 16.5 kHz where hearing is weakest, and the cover’s own bins up there are zeroed so nothing collides.' },
  { title: 'Add and return to time', text: 'The two spectra are summed and a single inverse FFT produces the stego waveform, peak-limited so it never clips.' },
  { title: 'The stego file', text: 'It sounds like the cover track, but now carries the scrambled voice at 16.5–19.9 kHz and the encrypted text lane above it.' },
]

/** The block a step should select: the secret/text lane reads better than the cover lane. */
function primaryIdFor(level: number): string {
  const node = ENCODE_NODES.find((n) => n.order === level && n.id !== 'cover' && n.id !== 'bandstop') ?? ENCODE_NODES.find((n) => n.order === level)
  return node?.id ?? ENCODE_NODES[0].id
}

const BEGINNER_HIDE_TOUR_STEPS: BeginnerTourStep[] = [
  {
    target: 'encode-overview',
    title: 'What are we doing?',
    text: 'We are hiding the secret information inside the cover audio.\n\nThe goal is to create a new audio signal that still sounds like the original, but now carries the hidden information.',
  },
  {
    target: 'frequency-spectrum',
    title: 'Why are we doing this?',
    text: 'The secret should not be obvious to someone listening to the audio.\n\nInstead of simply adding the secret as another audible sound, we embed information into selected parts of the audio spectrum.',
  },
  {
    target: 'fft-pipeline',
    title: 'How does it work?',
    text: 'First, we use the FFT (Fast Fourier Transform) to represent the audio in the frequency domain.\n\nThis lets us work with individual frequency components instead of only the waveform in time.\n\nThe hidden information is then embedded into a selected high-frequency region.',
  },
  {
    target: 'encode-action',
    title: 'Your turn',
    text: 'The system is ready to encode the secret.\n\nStart the encoding process and watch how the signal changes in the frequency domain.\n\nAfter encoding, we will inspect the result before sending it through the simulated channel.',
  },
]

export function EncodeStep() {
  const { encoded, key, goTo, uiMode } = useStegoStore()
  /** Highest `order` revealed so far: the walkthrough only advances when the user asks it to. */
  const [revealed, setRevealed] = useState(0)
  const [selected, setSelected] = useState<string>(primaryIdFor(0))
  const [tourOpen, setTourOpen] = useState(uiMode === 'beginner')

  useEffect(() => {
    setTourOpen(uiMode === 'beginner')
  }, [uiMode])

  // A fresh encode restarts the walkthrough at the first block.
  useEffect(() => {
    setRevealed(0)
    setSelected(primaryIdFor(0))
  }, [encoded])

  // Stepping moves the diagram, the explanation and the inspector together.
  const goToStep = (level: number) => {
    const next = Math.max(0, Math.min(MAX_ORDER, level))
    setRevealed(next)
    setSelected(primaryIdFor(next))
  }

  const node = useMemo(() => ENCODE_NODES.find((n) => n.id === selected) ?? ENCODE_NODES[0], [selected])

  if (!encoded) return null
  const { stages, layout, permutation, firResponse, text } = encoded
  const noText = <p className="text-sm text-slate-400">No hidden text was entered on the Sender step, so the lane stays empty.</p>

  const extra =
    node.id === 'fir' ? (
      <div>
        <div className="mb-2 text-xs font-medium text-slate-300">FIR magnitude response |H(f)| (1023 taps, Hamming window)</div>
        <LineChart
          series={[{ x: firResponse.freqs, y: firResponse.magDb, color: '#a78bfa', label: '|H(f)|' }]}
          xDomain={[0, 6000]}
          yDomain={[-100, 5]}
          height={180}
          xFormat={(v) => (v / 1000).toFixed(1)}
        />
      </div>
    ) : node.id === 'permute' ? (
      <PermutationView permutation={permutation} keyLabel={key} />
    ) : node.id === 'text' || node.id === 'aes' ? (
      text ? <CipherFrameView cipher={text.cipher} plaintext={text.plaintext} /> : noText
    ) : node.id === 'spread' ? (
      text ? (
        <div className="space-y-3">
          <LaneStats info={text} />
          <BitGrid bits={text.bits} title="Transmitted bits (header outlined)" />
        </div>
      ) : (
        noText
      )
    ) : null

  return (
    <div className="space-y-6">
      <Card data-tour-target="encode-overview" className="border-cyan-400/20 bg-cyan-400/[0.04]">
        <CardTitle title="How did this work?" hint="Technical explanation" />
        <p className="text-sm leading-relaxed text-slate-300">
          The application transforms the audio into the frequency domain using FFT, places the hidden information in a high-frequency region, and converts the result back into audio. The detailed DSP visualisations below let you inspect every stage.
        </p>
      </Card>
      <div data-tour-target="fft-pipeline">
        <Card>
        <CardTitle
          icon={<Workflow className="size-4" />}
          title="Encoder block diagram"
          hint="Step through the encoder one block at a time, or click any block to inspect and listen to the signal there."
          right={
            <Button variant="ghost" size="sm" onClick={() => goToStep(0)} icon={<RotateCcw className="size-3.5" />} disabled={revealed === 0}>
              Restart
            </Button>
          }
        />
        <PipelineFlow
          nodes={ENCODE_NODES}
          edges={ENCODE_EDGES}
          revealed={revealed}
          selectedId={selected}
          onSelect={setSelected}
          height={400}
          slowReveal
        />

        <div className="mt-4 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/10">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                Step {revealed + 1} of {MAX_ORDER + 1}
              </div>
              <h4 className="mt-1 text-sm font-semibold text-white">{STEP_GUIDE[revealed].title}</h4>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">{STEP_GUIDE[revealed].text}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => goToStep(revealed - 1)} disabled={revealed === 0} icon={<ChevronLeft className="size-4" />}>
                Back
              </Button>
              <Button size="sm" onClick={() => goToStep(revealed + 1)} disabled={revealed >= MAX_ORDER} icon={<ChevronRight className="size-4" />}>
                {revealed >= MAX_ORDER ? 'Done' : 'Next'}
              </Button>
            </div>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10" role="presentation">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-400 transition-all duration-500"
              style={{ width: `${((revealed + 1) / (MAX_ORDER + 1)) * 100}%` }}
            />
          </div>
        </div>
        </Card>
      </div>

      <div data-tour-target="frequency-spectrum">
        <StageInspector node={node} views={stages} layout={layout} extra={extra} spectrumOnly />
      </div>

      <div data-tour-target="encode-action" className="flex justify-end pt-1">
        <Button size="lg" onClick={() => goTo(2)} icon={<ArrowRight className="size-5" />}>
          Send the audio
        </Button>
      </div>
      <BeginnerTour open={uiMode === 'beginner' && tourOpen} steps={BEGINNER_HIDE_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
