import { ArrowRight, Check, CircleAlert, CircleDashed, Dices, Eye, EyeOff, Inbox, KeyRound, LockKeyhole, Mic, Music, Shuffle, TriangleAlert, UserCheck, WandSparkles } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { loadClipFromFile } from '../audio/load-audio'
import { AudioSourceCard } from '../components/audio/audio-source-card'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { Panel, SectionHeading } from '../components/sender/panel'
import { HiddenTextCard } from '../components/text-lane/hidden-text-card'
import { Button, cn } from '../components/ui/primitives'
import { CARRIER_LOW_HZ, GUARD_HZ, NUM_SUBBANDS, SECRET_HIGH_HZ, SECRET_LOW_HZ } from '../dsp/constants'
import { useStegoStore } from '../store/use-stego-store'
import { validateSender, type SenderIssue } from './sender-validation'

function randomKey(): string {
  const words = ['nyquist', 'fourier', 'butterfly', 'twiddle', 'aliasing', 'hilbert', 'cepstrum', 'parseval']
  const w = words[Math.floor(Math.random() * words.length)]
  return `${w}-${Math.floor(1000 + Math.random() * 9000)}`
}

/** Where the scrambled voice ends up in the stego file (display only — the runtime band is quantised to the FFT grid). */
const VOICE_LANE_LOW_KHZ = CARRIER_LOW_HZ / 1000
const VOICE_LANE_HIGH_KHZ = (CARRIER_LOW_HZ + (SECRET_HIGH_HZ + GUARD_HZ) - (SECRET_LOW_HZ - GUARD_HZ)) / 1000

const BEGINNER_TOUR_STEPS: BeginnerTourStep[] = [
  { target: 'cover-audio', title: 'Choose your cover audio', text: 'This is the normal audio that everyone will hear. It becomes the signal that carries the hidden information.' },
  { target: 'secret-audio', title: 'Choose your secret audio', text: 'This is the voice you want to hide inside the cover audio.' },
  { target: 'hidden-text', title: 'Add a hidden text message', text: 'You can also hide a short written message. It is encrypted and travels in its own frequency lane, alongside the voice.' },
  { target: 'secret-key', title: 'Set your secret key', text: 'The same key is needed later to recover the hidden information.' },
  { target: 'encode-action', title: "You're ready to encode", text: "You've selected the signals and key. Continue when you're ready for the next stage." },
]

const KEY_FACTS: { icon: ReactNode; text: string }[] = [
  { icon: <Shuffle className="size-3.5" />, text: `Shuffles the ${NUM_SUBBANDS} voice sub-bands` },
  { icon: <LockKeyhole className="size-3.5" />, text: 'Derives the AES-256 text key' },
  { icon: <UserCheck className="size-3.5" />, text: 'The receiver needs the same key' },
]

type ReplaceReason = 'transcript' | 'sample' | 'clear'

const REPLACE_COPY: Record<ReplaceReason, string> = {
  transcript: 'Transcribed from your recording — edit it before encoding.',
  sample: 'Sample text inserted, replacing what was there.',
  clear: 'Hidden text cleared.',
}

function IssueList({ issues, tone }: { issues: SenderIssue[]; tone: 'blocking' | 'warning' }) {
  if (issues.length === 0) return null
  const blocking = tone === 'blocking'
  const Icon = blocking ? CircleAlert : TriangleAlert
  return (
    <ul className={cn('space-y-1.5 text-xs leading-relaxed', blocking ? 'text-rose-200' : 'text-amber-200/90')}>
      {issues.map((issue) => (
        <li key={issue.id} className="flex items-start gap-2">
          <Icon className={cn('mt-0.5 size-3.5 shrink-0', blocking ? 'text-rose-400' : 'text-amber-400')} aria-hidden="true" />
          <span>{issue.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function ReadyChip({ done, optional, label }: { done: boolean; optional?: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition',
        done ? 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30' : optional ? 'text-slate-500 ring-white/10' : 'text-slate-400 ring-white/10',
      )}
    >
      {done ? <Check className="size-3" aria-hidden="true" /> : <CircleDashed className="size-3" aria-hidden="true" />}
      {label}
      {optional && !done && <span className="text-slate-600">· optional</span>}
    </span>
  )
}

export function SenderStep() {
  const { cover, secret, key, busy, uiMode, setCover, setSecret, setKey, setError, encode, goTo, setReceivedFile, hiddenText, setHiddenText } = useStegoStore()
  const receivedRef = useRef<HTMLInputElement>(null)
  const [tourOpen, setTourOpen] = useState(uiMode === 'beginner')
  const [showKey, setShowKey] = useState(false)
  /** The key field only turns red once the user has interacted with it. */
  const [keyTouched, setKeyTouched] = useState(false)
  /** Text a bulk action replaced, kept so the user can undo an unwanted overwrite. */
  const [replaced, setReplaced] = useState<{ text: string; reason: ReplaceReason } | null>(null)

  // Every blocking rule here is one the encoder enforces, so the button and the DSP agree.
  const status = useMemo(
    () => validateSender({ cover, secret, key, hiddenText, beginner: uiMode === 'beginner' }),
    [cover, secret, key, hiddenText, uiMode],
  )
  const blockedBy = (prefix: string) => status.blocking.some((i) => i.id.startsWith(prefix))

  useEffect(() => {
    setTourOpen(uiMode === 'beginner')
  }, [uiMode])

  // Bulk changes (transcript, sample text, clearing) stash the old text so nothing is lost by accident.
  const replaceText = (next: string, reason: ReplaceReason) => {
    const current = useStegoStore.getState().hiddenText
    if (current === next) return
    setReplaced({ text: current, reason })
    setHiddenText(next)
  }

  // Speech recognised while recording lands in the hidden text box, where it stays editable.
  const applyTranscript = (text: string) => {
    const trimmed = text.trim()
    if (trimmed) replaceText(trimmed, 'transcript')
  }

  // Typing is a deliberate edit, so the undo banner no longer applies.
  const editText = (text: string) => {
    setReplaced(null)
    setHiddenText(text)
  }

  const undoReplace = () => {
    if (!replaced) return
    setHiddenText(replaced.text)
    setReplaced(null)
  }

  const openReceived = async (file: File) => {
    try {
      setReceivedFile(await loadClipFromFile(file))
      goTo(3)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const secretWarning = status.warnings.find((i) => i.id === 'secret-longer')?.detail ?? null

  const run = async () => {
    if (!status.ready) {
      setError(status.blocking[0].detail)
      return
    }
    // Encoding runs on the Encode step, where its live block diagram follows the worker.
    void encode()
    goTo(1)
  }

  const keyMissing = blockedBy('key-missing')
  const keyIssue = status.warnings.find((i) => i.id.startsWith('key-'))

  return (
    <div className="space-y-10">
      <section aria-labelledby="sender-carrier">
        <SectionHeading
          eyebrow="Carrier"
          title={uiMode === 'beginner' ? 'The audio everyone will hear' : 'Cover signal'}
          hint="This track is transmitted openly. The hidden lanes are added near the top of its spectrum, above what the ear notices."
          accent="cyan"
        />
        <div data-tour-target="cover-audio" id="sender-carrier">
          <AudioSourceCard
            title={uiMode === 'beginner' ? 'Upload cover audio' : 'Audio everyone will hear'}
            hint={
              uiMode === 'beginner'
                ? 'This is the normal audio an outside listener will hear.'
                : 'Choose the normal cover audio. This is the cover signal used by the steganography system.'
            }
            eyebrow="Cover track"
            icon={<Music className="size-4" />}
            clip={cover}
            onClip={setCover}
            onError={setError}
            demoUrl={`${import.meta.env.BASE_URL}samples/cover-demo.wav`}
            demoName="Demo cover — synth groove (11.5 s)"
            color="cyan"
            wide
          />
        </div>
      </section>

      <section aria-labelledby="sender-payload">
        <SectionHeading
          eyebrow="Payload"
          title="What you are hiding"
          hint="A spoken message and a written message, carried in two separate frequency lanes of the same file. Use either one, or both together."
          accent="violet"
        />
        <div id="sender-payload" className="grid items-stretch gap-5 lg:grid-cols-2">
          <div data-tour-target="secret-audio" className="h-full">
            <AudioSourceCard
              title="Voice message to hide"
              hint="Record or upload the secret voice. Speech is band-limited to 300–3400 Hz before frequency-domain embedding."
              eyebrow={uiMode === 'beginner' ? 'Voice message' : `Voice lane · ${VOICE_LANE_LOW_KHZ}–${VOICE_LANE_HIGH_KHZ} kHz`}
              icon={<Mic className="size-4" />}
              clip={secret}
              onClip={setSecret}
              onError={setError}
              demoUrl={`${import.meta.env.BASE_URL}samples/secret-demo.wav`}
              demoName="Demo secret — synthesized voice"
              allowRecord
              color="violet"
              warning={secretWarning}
              onTranscript={applyTranscript}
              delay={0.05}
            />
          </div>
          <div data-tour-target="hidden-text" className="h-full">
            <HiddenTextCard
              text={hiddenText}
              onChange={editText}
              cover={cover}
              eyebrow={uiMode === 'beginner' ? 'Text message' : undefined}
              hint={uiMode === 'beginner' ? 'A short written message hidden alongside the voice. It is encrypted with your secret key.' : undefined}
              onReplace={replaceText}
              notice={
                replaced && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-violet-400/10 px-3 py-2 text-xs text-violet-200 ring-1 ring-violet-400/25">
                    <span className="inline-flex items-center gap-2">
                      <WandSparkles className="size-3.5 shrink-0" aria-hidden="true" />
                      {REPLACE_COPY[replaced.reason]}
                    </span>
                    <button onClick={undoReplace} className="shrink-0 rounded-lg px-2 py-0.5 font-semibold text-violet-100 ring-1 ring-violet-300/30 transition hover:bg-violet-400/20">
                      Undo
                    </button>
                  </div>
                )
              }
              delay={0.1}
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="sender-key">
        <SectionHeading
          eyebrow="Security"
          title="One key for both lanes"
          hint="One key protects both lanes. Without it the recovered audio is unintelligible and the text never decrypts."
          accent="amber"
        />
        <div data-tour-target="secret-key" id="sender-key">
          <Panel
            accent="amber"
            icon={<KeyRound className="size-4" />}
            eyebrow="Shared secret"
            title="Secret key"
            hint="The receiver needs the same key. It controls keyed sub-band scrambling so the hidden voice can be recovered."
            actions={
              <Button variant="secondary" size="sm" onClick={() => {
                  // show a generated key so it can be shared with the receiver
                  setKey(randomKey())
                  setShowKey(true)
                }} icon={<Dices className="size-3.5" />}>
                Generate random key
              </Button>
            }
            footer={
              <ul className="grid gap-2 sm:grid-cols-3">
                {KEY_FACTS.map((f) => (
                  <li key={f.text} className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-slate-400 ring-1 ring-white/10">
                    <span className="text-amber-200/80">{f.icon}</span>
                    {f.text}
                  </li>
                ))}
              </ul>
            }
            filled={!keyMissing}
            wide
            delay={0.05}
          >
            <div className="max-w-xl space-y-2">
              <label className="sr-only" htmlFor="key">
                Secret key
              </label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-amber-200/60" aria-hidden="true" />
                <input
                  id="key"
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => {
                    setKeyTouched(true)
                    setKey(e.target.value)
                  }}
                  onBlur={() => setKeyTouched(true)}
                  className={cn(
                    'w-full rounded-xl bg-black/30 py-3 pl-10 pr-12 font-mono text-sm tracking-wide text-amber-200 outline-none ring-1 transition focus:ring-amber-300/60',
                    keyMissing && keyTouched ? 'ring-rose-400/50' : 'ring-white/10',
                  )}
                  placeholder="enter a secret key…"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={keyMissing && keyTouched}
                  aria-describedby="key-help"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-pressed={showKey}
                  aria-label={showKey ? 'Hide the secret key' : 'Show the secret key'}
                  title={showKey ? 'Hide the secret key' : 'Show the secret key'}
                  className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-amber-200"
                >
                  {showKey ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                </button>
              </div>
              <p id="key-help" className={cn('text-xs leading-relaxed', keyMissing && keyTouched ? 'text-rose-300' : keyIssue ? 'text-amber-300' : 'text-slate-500')}>
                {keyMissing
                  ? keyTouched
                    ? 'A secret key is required before the audio can be encoded.'
                    : 'Enter a secret key, or generate one. The receiver will need exactly the same key.'
                  : (keyIssue?.detail ?? 'Share it with the receiver through a separate, trusted channel.')}
              </p>
            </div>
          </Panel>
        </div>
      </section>

      <motion.div
        data-tour-target="encode-action"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1, ease: 'easeOut' }}
        className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-ink-900/50 p-5 shadow-xl shadow-black/20 backdrop-blur lg:flex-row lg:items-start lg:justify-between"
      >
        <div className="min-w-0 space-y-3">
          <div id="sender-blocking" className="flex flex-wrap items-center gap-2">
            <ReadyChip done={!!cover && !blockedBy('cover-')} label="Cover audio" />
            <ReadyChip done={!!secret && !blockedBy('secret-')} optional label="Voice message" />
            <ReadyChip done={hiddenText.trim().length > 0 && !blockedBy('text-')} optional label="Hidden text" />
            <ReadyChip done={!keyMissing} label="Secret key" />
          </div>
          <IssueList issues={status.blocking} tone="blocking" />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <button
            onClick={() => receivedRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-400 ring-1 ring-white/10 transition hover:text-white"
          >
            <Inbox className="size-4" /> Received a stego file? Decode it directly
          </button>
          <input
            ref={receivedRef}
            type="file"
            accept="audio/*"
            className="hidden"
            aria-label="Received stego file"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void openReceived(f)
            }}
          />
          <Button
            size="lg"
            onClick={run}
            loading={busy === 'encode'}
            disabled={!status.ready}
            aria-describedby={status.ready ? undefined : 'sender-blocking'}
            title={status.ready ? undefined : status.blocking.map((i) => i.detail).join('\n')}
            icon={<ArrowRight className="size-5" />}
          >
            {uiMode === 'beginner' ? 'Continue →' : 'Hide secret in audio'}
          </Button>
        </div>
      </motion.div>
      <BeginnerTour open={uiMode === 'beginner' && tourOpen} steps={BEGINNER_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
