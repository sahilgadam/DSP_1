import {
  ArrowRight,
  Binary,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  FileAudio,
  KeyRound,
  Lock,
  LockOpen,
  RotateCcw,
  TriangleAlert,
  Upload,
  Workflow,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { loadClipFromFile, type AudioClip } from '../audio/load-audio'
import { WaveformPlayer } from '../components/audio/waveform-player'
import { ButterflyExplorer } from '../components/butterfly/butterfly-explorer'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { PipelineFlow } from '../components/pipeline/pipeline-flow'
import { PermutationView } from '../components/pipeline/permutation-view'
import { TextDecodePanel, TextStatusBanner } from '../components/text-lane/text-result'
import { BitGrid, ConstellationPlot } from '../components/text-lane/text-lane-views'
import { StageInspector } from '../components/pipeline/stage-inspector'
import { Button, Card, CardTitle, Tabs, TabsContent, TabsList, cn } from '../components/ui/primitives'
import { SAMPLE_RATE } from '../dsp/constants'
import { DECODE_EDGES, DECODE_NODES } from '../pipeline/stage-meta'
import { useStegoStore } from '../store/use-stego-store'
import { channelLabel, formatBytes, formatHz } from './sender-validation'
import { checkReceivedAudio, checkReceiverKey } from './receiver-validation'
import { useReveal } from './use-reveal'

const MAX_ORDER = Math.max(...DECODE_NODES.map((n) => n.order))

// One step per gate. Every target is a card that stays mounted, locked or not, so the tour never
// points at a control that has not appeared yet.
const BEGINNER_RECEIVER_TOUR_STEPS: BeginnerTourStep[] = [
  {
    target: 'receiver-overview',
    title: 'What are we doing?',
    text: 'We are the receiver now.\n\nAll we have is the audio file that arrived — load it here to begin. Nothing is carried over from the sender.',
  },
  {
    target: 'receiver-key',
    title: 'Why do we need the key?',
    text: 'The hidden information was scrambled with a shared secret key.\n\nYou have to type that key in yourself. This step unlocks once a valid file is loaded.',
  },
  {
    target: 'receiver-key',
    title: 'Your turn',
    text: 'Press Unlock. A wrong key is rejected straight away.\n\nWith the right key the decoder opens: the FFT finds the hidden frequency region, extracts the information and rebuilds the secret.',
  },
]

/** Size of the 16-bit WAV the channel step hands you, so the panel reads like a real file. */
const wavBytes = (samples: number) => 44 + samples * 2

/** One numbered step of the receiver flow. Locked steps stay mounted but show no controls. */
function GateCard({
  index,
  title,
  hint,
  icon,
  locked,
  lockedHint,
  done,
  tourTarget,
  children,
}: {
  index: number
  title: string
  hint: string
  icon: ReactNode
  locked?: boolean
  lockedHint?: string
  done?: boolean
  tourTarget: string
  children: ReactNode
}) {
  return (
    <div data-tour-target={tourTarget}>
      <Card className={cn('transition-opacity', locked && 'opacity-60')}>
        <div className="mb-4 flex items-start gap-3">
          <span
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-xl text-sm font-semibold ring-1',
              locked ? 'bg-white/5 text-slate-500 ring-white/10' : done ? 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30' : 'bg-cyan-400/10 text-cyan-300 ring-cyan-400/30',
            )}
          >
            {locked ? <Lock className="size-4" aria-hidden="true" /> : done ? <CircleCheck className="size-4" aria-hidden="true" /> : index}
          </span>
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-wide text-white">
              {icon}
              {title}
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{locked ? lockedHint : hint}</p>
          </div>
        </div>
        {!locked && children}
      </Card>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'error' | 'warning' | 'ok'; children: ReactNode }) {
  const tones = {
    error: { cls: 'bg-rose-500/10 text-rose-200 ring-rose-400/30', Icon: CircleAlert, iconCls: 'text-rose-400' },
    warning: { cls: 'bg-amber-400/10 text-amber-100 ring-amber-400/30', Icon: TriangleAlert, iconCls: 'text-amber-400' },
    ok: { cls: 'bg-emerald-400/10 text-emerald-100 ring-emerald-400/30', Icon: CircleCheck, iconCls: 'text-emerald-400' },
  }[tone]
  const { Icon } = tones
  return (
    <div className={cn('flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-xs leading-relaxed ring-1', tones.cls)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tones.iconCls)} aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function ReceiverStep() {
  const s = useStegoStore()
  const { decoded, receiverKey, fftKind, busy, receivedFile, transmitted } = s
  const fileRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState('butterfly')
  const [epoch, setEpoch] = useState(0)
  const revealed = useReveal(MAX_ORDER, tab === 'pipeline' ? decoded : null, epoch)
  const [selected, setSelected] = useState('recovered')
  const [tourOpen, setTourOpen] = useState(s.uiMode === 'beginner')
  const node = useMemo(() => DECODE_NODES.find((n) => n.id === selected) ?? DECODE_NODES[0], [selected])

  const [loadingFile, setLoadingFile] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [decodeError, setDecodeError] = useState<string | null>(null)

  useEffect(() => {
    setTourOpen(s.uiMode === 'beginner')
  }, [s.uiMode])

  useEffect(() => {
    const latest = DECODE_NODES.find((n) => n.order === revealed)
    if (latest) setSelected(latest.id)
  }, [revealed])

  // The received file is the receiver's only input; checking it costs one PSD, so memoise per clip.
  const audioCheck = useMemo(() => checkReceivedAudio(receivedFile), [receivedFile])
  const audioReady = !!receivedFile && !audioCheck.error
  // AES-GCM authentication is the key check: every file this app writes carries an authenticated frame
  const verified = decoded?.text.status === 'ok'
  const keyWrong = !!decoded && !verified

  const accept = async (file: File) => {
    setLoadingFile(true)
    setFileError(null)
    setDecodeError(null)
    try {
      s.setReceivedFile(await loadClipFromFile(file))
    } catch (e) {
      s.setReceivedFile(null)
      setFileError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFile(false)
    }
  }

  /** The channel step hands over the same bytes its download button writes. */
  const useChannelAudio = () => {
    if (!transmitted) return
    const samples = transmitted.received.samples
    const clip: AudioClip = {
      name: 'received.wav (from the simulated channel)',
      samples,
      duration: samples.length / SAMPLE_RATE,
      truncated: false,
      source: { kind: 'file', bytes: wavBytes(samples.length), format: 'WAV', channels: 1, sourceSampleRate: SAMPLE_RATE },
    }
    setFileError(null)
    setDecodeError(null)
    s.setReceivedFile(clip)
  }

  const clearFile = () => {
    s.setReceivedFile(null)
    setFileError(null)
    setDecodeError(null)
  }

  /** Decodes with the typed key; the result decides between "Key is incorrect" and the decoder views. */
  const unlock = async () => {
    if (!audioReady || checkReceiverKey(receiverKey).error) return
    setDecodeError(null)
    const ok = await s.decode()
    if (!ok) {
      const err = useStegoStore.getState().error
      if (err) {
        setDecodeError(err)
        s.setError(null)
      }
    }
  }

  const info = receivedFile?.source ?? null

  // Once the key verifies: bring the butterfly animation into view (it starts by itself), and when it
  // has finished, carry on down to the end of the page.
  const decoderRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const [verifyRun, setVerifyRun] = useState(0)
  useEffect(() => {
    if (!verified) return
    setTab('butterfly')
    setVerifyRun((r) => r + 1)
    const t = setTimeout(() => decoderRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }), 400)
    return () => clearTimeout(t)
  }, [verified, decoded, reduceMotion])

  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollToEnd = useCallback(() => {
    // a short pause so the finished spectrum is seen before moving on
    endTimer.current = setTimeout(() => endRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'end' }), 1200)
  }, [reduceMotion])
  useEffect(() => () => {
    if (endTimer.current) clearTimeout(endTimer.current)
  }, [])

  return (
    <div className="space-y-6">
      <GateCard
        index={1}
        tourTarget="receiver-overview"
        icon={<FileAudio className="size-4 text-cyan-300" />}
        title="Load the received audio"
        hint="The receiver starts with nothing but the file that arrived. Load the stego WAV you downloaded."
      >
        <div className="space-y-3">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              if (!loadingFile) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const f = e.dataTransfer.files?.[0]
              if (f && !loadingFile) void accept(f)
            }}
          >
            {receivedFile && !audioCheck.error ? (
              <div className="space-y-3">
                <WaveformPlayer samples={receivedFile.samples} label={receivedFile.name} color="cyan" height={72} />
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  {[
                    ['Duration', `${receivedFile.duration.toFixed(2)} s`],
                    ['Format', info ? `${info.format} · ${channelLabel(info.channels)}` : 'decoded audio'],
                    ['Sample rate', formatHz(info?.sourceSampleRate ?? SAMPLE_RATE)],
                    ['File size', info ? formatBytes(info.bytes) : '—'],
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-wider text-slate-500">{label}</dt>
                      <dd className="truncate font-mono text-[11px] text-slate-300">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={loadingFile}
                className={cn(
                  'flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition',
                  dragging ? 'border-cyan-300/70 bg-cyan-400/5 text-cyan-200' : 'border-white/15 text-slate-500 hover:border-white/30 hover:text-slate-300',
                )}
              >
                <Upload className="size-6" aria-hidden="true" />
                <span>{loadingFile ? 'Reading the file…' : dragging ? 'Drop the file to load it' : 'Drop the stego WAV here, or click to choose one'}</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()} disabled={loadingFile}>
              {receivedFile ? 'Choose another file' : 'Choose file'}
            </Button>
            {receivedFile && (
              <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={clearFile}>
                Clear
              </Button>
            )}
            {!receivedFile && transmitted && (
              <button onClick={useChannelAudio} className="text-xs text-cyan-300 underline-offset-2 hover:underline">
                or use the file from the simulated channel
              </button>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            aria-label="Received stego audio"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void accept(f)
            }}
          />

          {fileError && <Notice tone="error">{fileError}</Notice>}
          {audioCheck.error && <Notice tone="error">{audioCheck.error}</Notice>}
          {audioCheck.warning && <Notice tone="warning">{audioCheck.warning}</Notice>}
        </div>
      </GateCard>

      <GateCard
        index={2}
        tourTarget="receiver-key"
        icon={<KeyRound className="size-4 text-amber-200" />}
        title="Enter the secret key"
        hint="Type the key the sender shared with you. It is never filled in for you."
        locked={!audioReady}
        lockedHint="Unlocks once a valid audio file is loaded."
        done={verified}
      >
        <div className="space-y-3">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              void unlock()
            }}
          >
            <div className="relative grow">
              <label htmlFor="rkey" className="sr-only">
                Secret key
              </label>
              <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-amber-200/60" aria-hidden="true" />
              <input
                id="rkey"
                type={showKey ? 'text' : 'password'}
                value={receiverKey}
                placeholder="the sender’s secret key…"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={keyWrong}
                aria-describedby="rkey-status"
                onChange={(e) => {
                  s.setReceiverKey(e.target.value)
                  setDecodeError(null)
                }}
                className={cn(
                  'w-full rounded-xl bg-black/30 py-3 pl-10 pr-12 font-mono text-sm tracking-wide text-amber-200 outline-none ring-1 transition focus:ring-amber-300/60',
                  keyWrong ? 'ring-rose-400/60' : verified ? 'ring-emerald-400/50' : 'ring-white/10',
                )}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-pressed={showKey}
                aria-label={showKey ? 'Hide the key' : 'Show the key'}
                className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-amber-200"
              >
                {showKey ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
            <Button type="submit" loading={busy === 'decode'} disabled={receiverKey.trim().length === 0 || busy === 'decode'} icon={<LockOpen className="size-4" />}>
              Unlock
            </Button>
          </form>

          <div id="rkey-status" aria-live="polite">
            {keyWrong && (
              <motion.div
                initial={{ opacity: 0, x: 0 }}
                animate={{ opacity: 1, x: [0, -6, 6, -4, 4, 0] }}
                transition={{ duration: 0.4 }}
                className="flex items-center gap-2.5 rounded-xl bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-200 ring-1 ring-rose-400/40"
              >
                <CircleAlert className="size-5 shrink-0 text-rose-400" aria-hidden="true" />
                Key is incorrect
              </motion.div>
            )}
            {verified && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2.5 rounded-xl bg-emerald-400/10 px-4 py-3 text-sm font-semibold text-emerald-200 ring-1 ring-emerald-400/30"
              >
                <CircleCheck className="size-5 shrink-0 text-emerald-400" aria-hidden="true" />
                Key verified
              </motion.div>
            )}
            {decodeError && <Notice tone="error">{decodeError}</Notice>}
          </div>
        </div>
      </GateCard>

      {verified && decoded && receivedFile && (
        <div ref={decoderRef} className="scroll-mt-40">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList
              tabs={[
                { value: 'butterfly', label: 'FFT butterflies', icon: <Binary className="size-4" /> },
                { value: 'pipeline', label: 'Decoder pipeline', icon: <Workflow className="size-4" /> },
              ]}
            />
            <TabsContent value="butterfly">
              <ButterflyExplorer
                key={`${fftKind}-${decoded.fftSize}-${verifyRun}`}
                received={receivedFile.samples}
                initialKind={fftKind}
                stats={{ ...decoded, kind: fftKind }}
                onFinished={scrollToEnd}
              />
            </TabsContent>
            <TabsContent value="pipeline" className="space-y-6">
              <Card>
                <CardTitle
                  icon={<Workflow className="size-4" />}
                  title="Decoder block diagram"
                  hint="The exact mirror of the encoder. Click a block to hear the signal there."
                  right={
                    <Button variant="ghost" size="sm" onClick={() => setEpoch((e) => e + 1)}>
                      Replay
                    </Button>
                  }
                />
                <PipelineFlow nodes={DECODE_NODES} edges={DECODE_EDGES} revealed={revealed} selectedId={selected} onSelect={setSelected} height={400} />
              </Card>
              <StageInspector
                node={node}
                views={decoded.stages}
                layout={decoded.layout}
                extra={
                  node.id === 'unpermute' ? (
                    <PermutationView permutation={decoded.permutation} keyLabel={receiverKey} />
                  ) : node.id === 'despread' ? (
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
                      <div className="rounded-xl bg-black/30 p-3 ring-1 ring-white/10">
                        <div className="mb-1 text-[11px] text-slate-400">Despread symbols (BPSK constellation)</div>
                        <ConstellationPlot re={decoded.text.softRe} im={decoded.text.softIm} />
                      </div>
                      {/* No reference bits: the receiver only ever sees what it decoded itself. */}
                      <BitGrid bits={decoded.text.bits} title="Decided bits" />
                    </div>
                  ) : node.id === 'decrypt' ? (
                    <TextStatusBanner info={decoded.text} />
                  ) : node.id === 'message' ? (
                    <TextDecodePanel info={decoded.text} sent={null} />
                  ) : null
                }
              />
            </TabsContent>
          </Tabs>
        </div>
      )}

      {verified && (
        <div ref={endRef} className="flex justify-end scroll-mb-10">
          <Button size="lg" onClick={() => s.goTo(4)} icon={<ArrowRight className="size-5" />}>
            Show the hidden message
          </Button>
        </div>
      )}
      <BeginnerTour open={s.uiMode === 'beginner' && tourOpen} steps={BEGINNER_RECEIVER_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
