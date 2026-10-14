import { CloudUpload, Mic, RotateCcw, Sparkles, Square, TriangleAlert, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { loadClipFromFile, loadClipFromUrl, MicRecorder, type AudioClip } from '../../audio/load-audio'
import {
  isTranscriptionSupported,
  SpeechTranscriber,
  TRANSCRIPTION_UNSUPPORTED_MESSAGE,
  TRANSCRIPTION_UPLOAD_MESSAGE,
} from '../../audio/speech-to-text'
import { MAX_DURATION_S, SAMPLE_RATE } from '../../dsp/constants'
import { channelLabel, formatBytes, formatHz, isSilent } from '../../steps/sender-validation'
import { Panel, StatusPill } from '../sender/panel'
import { Badge, Button, cn } from '../ui/primitives'
import { WaveformPlayer } from './waveform-player'

/** One label/value pair in the clip details grid. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-slate-300" title={value}>
        {value}
      </dd>
    </div>
  )
}

interface AudioSourceCardProps {
  title: string
  hint: string
  icon: ReactNode
  /** Short uppercase label above the title — usually the frequency lane this audio travels in. */
  eyebrow: string
  clip: AudioClip | null
  onClip: (clip: AudioClip) => void
  onError: (msg: string) => void
  demoUrl: string
  demoName: string
  allowRecord?: boolean
  color: 'cyan' | 'violet'
  warning?: string | null
  /** Header and buttons sit side by side (used for the full-width carrier card). */
  wide?: boolean
  delay?: number
  /** Opt in to live speech-to-text: called with the recognised words once a recording finishes. */
  onTranscript?: (text: string) => void
}

export function AudioSourceCard({
  title,
  hint,
  icon,
  eyebrow,
  clip,
  onClip,
  onError,
  demoUrl,
  demoName,
  allowRecord,
  color,
  warning,
  wide,
  delay,
  onTranscript,
}: AudioSourceCardProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MicRecorder | null>(null)
  const transcriberRef = useRef<SpeechTranscriber | null>(null)
  const [loading, setLoading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [heard, setHeard] = useState('')
  const [speechNote, setSpeechNote] = useState<string | null>(null)
  /** The clip that was just replaced, so an accidental overwrite can be undone. */
  const [previous, setPrevious] = useState<AudioClip | null>(null)

  // Leaving the step mid-recording must not keep the microphone open.
  useEffect(
    () => () => {
      transcriberRef.current?.abort()
      transcriberRef.current = null
      recorderRef.current?.stop().catch(() => undefined)
      recorderRef.current = null
    },
    [],
  )

  const transcribes = !!onTranscript && !!allowRecord
  const speechSupported = transcribes && isTranscriptionSupported()

  /**
   * Loads a clip and remembers the one it displaced.
   * `keepSpeechNote` is set when finishing a recording: the note there explains why speech
   * recognition produced nothing, and must survive the clip it belongs to.
   */
  const guard = async (fn: () => Promise<AudioClip>, keepSpeechNote = false) => {
    const replacing = clip
    setLoading(true)
    try {
      const next = await fn()
      onClip(next)
      // Keep the displaced clip so a mis-click (especially over a recording) is recoverable.
      setPrevious(replacing)
      if (!keepSpeechNote) setSpeechNote(null)
      return true
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setLoading(false)
    }
  }

  const restorePrevious = () => {
    if (!previous) return
    onClip(previous)
    setPrevious(null)
    setSpeechNote(null)
  }

  const toggleRecord = async () => {
    if (recording) {
      setRecording(false)
      const rec = recorderRef.current
      recorderRef.current = null
      const transcriber = transcriberRef.current
      transcriberRef.current = null
      // Recognition must never hold up (or sink) the recording itself.
      const spoken = transcriber ? await transcriber.stop().catch(() => '') : ''
      const saved = rec ? await guard(() => rec.stop(), true) : false
      setHeard('')
      if (saved && spoken) onTranscript?.(spoken)
      return
    }
    const rec = new MicRecorder()
    try {
      await rec.start()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      return
    }
    recorderRef.current = rec
    setRecording(true)
    setHeard('')
    setSpeechNote(null)
    if (!transcribes) return
    if (!speechSupported) {
      setSpeechNote(TRANSCRIPTION_UNSUPPORTED_MESSAGE)
      return
    }
    const transcriber = new SpeechTranscriber()
    const started = transcriber.start({
      onUpdate: (settled, pending) => setHeard(`${settled} ${pending}`.trim()),
      onError: setSpeechNote,
    })
    if (started) transcriberRef.current = transcriber
    else setSpeechNote(TRANSCRIPTION_UNSUPPORTED_MESSAGE)
  }

  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (recording || loading) return
    const f = e.dataTransfer.files?.[0]
    if (f) void guard(() => loadClipFromFile(f))
  }

  const actions = (
    <>
      <Button variant="secondary" size="sm" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()} disabled={loading || recording}>
        Upload audio
      </Button>
      {allowRecord && (
        <Button
          variant={recording ? 'danger' : 'secondary'}
          size="sm"
          icon={recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
          onClick={toggleRecord}
          disabled={loading}
        >
          {recording ? 'Stop recording' : 'Record voice'}
        </Button>
      )}
      <Button
        variant="secondary"
        size="sm"
        icon={<Sparkles className="size-3.5" />}
        onClick={() => guard(() => loadClipFromUrl(demoUrl, demoName, 'demo'))}
        loading={loading}
        disabled={recording}
      >
        Use demo clip
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void guard(() => loadClipFromFile(f))
        }}
      />
    </>
  )

  // Origin comes from the clip itself, so it can never disagree with what is loaded.
  const origin = clip?.source?.kind ?? null

  // One line under the clip details explains what speech-to-text did, or why it did nothing.
  const speechHint = !transcribes
    ? null
    : speechNote
      ? { text: speechNote, tone: 'text-amber-300' }
      : !speechSupported
        ? { text: TRANSCRIPTION_UNSUPPORTED_MESSAGE, tone: 'text-slate-500' }
        : clip && origin && origin !== 'mic'
          ? { text: TRANSCRIPTION_UPLOAD_MESSAGE, tone: 'text-slate-500' }
          : { text: 'Recording also transcribes your speech into the hidden text message.', tone: 'text-slate-500' }

  const silent = !!clip && clip.samples.length > 0 && isSilent(clip)
  const info = clip?.source ?? null
  const rateValue = !info?.sourceSampleRate
    ? formatHz(SAMPLE_RATE)
    : info.sourceSampleRate === SAMPLE_RATE
      ? formatHz(SAMPLE_RATE)
      : `${formatHz(info.sourceSampleRate)} → ${formatHz(SAMPLE_RATE)}`

  const footer = clip ? (
    <div className="space-y-3">
      <dl className={cn('grid gap-x-4 gap-y-2 border-t border-white/5 pt-3', wide ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2')}>
        <Detail label="Duration" value={`${clip.duration.toFixed(2)} s`} />
        <Detail label="Format" value={info ? `${info.format} · ${channelLabel(info.channels)}` : 'decoded audio'} />
        <Detail label="Sample rate" value={rateValue} />
        <Detail label="File size" value={info ? formatBytes(info.bytes) : '—'} />
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{clip.samples.length.toLocaleString('en-US')} samples</Badge>
        <Badge>mono working copy</Badge>
        {clip.truncated && <Badge className="text-amber-300">trimmed to {MAX_DURATION_S} s</Badge>}
        {origin === 'mic' && <Badge className="text-violet-200">recorded</Badge>}
      </div>
      {silent && (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-rose-300">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          This audio is completely silent, so the encoder cannot use it. Load a clip with sound.
        </p>
      )}
      {warning && <p className="text-xs leading-relaxed text-amber-300">{warning}</p>}
      {speechHint && <p className={cn('text-xs leading-relaxed', speechHint.tone)}>{speechHint.text}</p>}
      {previous && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-slate-300 ring-1 ring-white/10">
          <span className="min-w-0 truncate">Replaced “{previous.name}”.</span>
          <button
            onClick={restorePrevious}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-0.5 font-semibold text-slate-100 ring-1 ring-white/15 transition hover:bg-white/10"
          >
            <RotateCcw className="size-3" aria-hidden="true" /> Undo
          </button>
        </div>
      )}
    </div>
  ) : (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">Drag an audio file onto this card, or use one of the buttons above.</p>
      {speechHint && <p className={cn('text-xs leading-relaxed', speechHint.tone)}>{speechHint.text}</p>}
    </div>
  )

  return (
    <Panel
      accent={color}
      icon={icon}
      eyebrow={eyebrow}
      title={title}
      hint={hint}
      status={<StatusPill tone={clip ? 'ready' : 'idle'} label={clip ? 'Loaded' : 'Empty'} />}
      actions={actions}
      footer={footer}
      wide={wide}
      filled={!!clip}
      delay={delay}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!recording && !loading) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className="flex grow flex-col"
      >
        {recording ? (
          <div className="flex min-h-[136px] grow flex-col gap-3 rounded-xl bg-rose-500/10 p-4 text-sm text-rose-200 ring-1 ring-rose-400/30">
            <div className="flex items-center gap-3">
              <span className="size-3 shrink-0 animate-pulse rounded-full bg-rose-400" /> Recording… speak your secret message
            </div>
            {speechSupported && (
              <p className="grow overflow-y-auto text-xs leading-relaxed text-rose-100/80" aria-live="polite">
                {heard || <span className="text-rose-200/50">Listening for speech…</span>}
              </p>
            )}
          </div>
        ) : clip ? (
          <div className="flex min-h-[136px] grow flex-col">
            <WaveformPlayer samples={clip.samples} label={clip.name} color={color} normalize height={wide ? 76 : 72} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex min-h-[136px] grow flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition',
              dragging ? 'border-cyan-300/70 bg-cyan-400/5 text-cyan-200' : 'border-white/15 text-slate-500 hover:border-white/30 hover:text-slate-300',
            )}
          >
            <CloudUpload className="size-6" aria-hidden="true" />
            <span>{dragging ? 'Drop the file to load it' : 'No audio loaded yet'}</span>
          </button>
        )}
      </div>
    </Panel>
  )
}
