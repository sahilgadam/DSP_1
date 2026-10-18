import { useState } from 'react'
import { AlertTriangle, AudioWaveform, Loader2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Stepper } from './components/layout/stepper'
import { WelcomeScreen } from './components/layout/welcome-screen'
import { ChannelStep } from './steps/channel-step'
import { EncodeStep } from './steps/encode-step'
import { OutputStep } from './steps/output-step'
import { ReceiverStep } from './steps/receiver-step'
import { SenderStep } from './steps/sender-step'
import { useStegoStore } from './store/use-stego-store'

const STEP_INTRO = [
  { title: 'Select Your Audio', text: 'Everyone hears the song. Only one person hears the secret.' },
  { title: 'Message Encoded', text: 'It still sounds exactly the same. That’s the whole trick.' },
  { title: 'Transmission', text: 'Out in the open. Nobody suspects a thing.' },
  { title: 'Decode the Message', text: 'No key, no secret.' },
  { title: 'Recovered Message', text: 'Sent in plain sound. Read by one.' },
]

const STEPS = [SenderStep, EncodeStep, ChannelStep, ReceiverStep, OutputStep]

const BUSY_TEXT = {
  encode: 'Hiding your secret…',
  channel: 'Sending your audio…',
  decode: 'Checking the key…',
} as const

export default function App() {
  const { step, error, setError, busy, uiMode, setUIMode, goTo, encoded, encodeError } = useStegoStore()
  const [welcomeOpen, setWelcomeOpen] = useState(true)
  const StepView = STEPS[step]
  // The Encode step's heading follows the real run rather than assuming it already succeeded.
  const intro =
    step === 1 && !encoded
      ? busy === 'encode'
        ? { title: 'Encoding in Progress', text: 'Watch it vanish into the music.' }
        : encodeError
          ? { title: 'Encoding Failed', text: '' }
          : { title: 'Ready to Encode', text: '' }
      : STEP_INTRO[step]
  // the Encode step shows its own live progress, so the floating toast would only repeat it
  const toast = busy && !(busy === 'encode' && step === 1) ? busy : null

  const selectMode = (mode: 'beginner' | 'dsp') => {
    setUIMode(mode)
    goTo(0)
    setWelcomeOpen(false)
  }

  if (welcomeOpen) return <WelcomeScreen onSelectMode={selectMode} />

  return (
    <div className="bg-grid min-h-screen">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-ink-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-ink-950 shadow-lg shadow-cyan-500/30">
              <AudioWaveform className="size-5" />
            </div>
            <div>
              <div className="text-base font-extrabold tracking-tight text-white">SpectraHide</div>
              <div className="text-[11px] text-slate-400">Hide a voice inside a song.</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="inline-flex rounded-xl bg-white/5 p-1 ring-1 ring-white/10" role="group" aria-label="Choose application view">
              <button
                type="button"
                aria-pressed={uiMode === 'beginner'}
                onClick={() => setUIMode('beginner')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:text-white aria-pressed:bg-cyan-400 aria-pressed:text-ink-950"
              >
                Guided
              </button>
              <button
                type="button"
                aria-pressed={uiMode === 'dsp'}
                onClick={() => setUIMode('dsp')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:text-white aria-pressed:bg-cyan-400 aria-pressed:text-ink-950"
              >
                Advanced
              </button>
            </div>
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-3 sm:px-6">
          <Stepper />
        </div>
        {busy && (
          <motion.div
            className="h-0.5 bg-gradient-to-r from-cyan-400 via-violet-400 to-cyan-400"
            initial={{ scaleX: 0, originX: 0 }}
            animate={{ scaleX: [0, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <AnimatePresence mode="wait">
          <motion.section
            key={step}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <div className="mb-6">
              <div className="font-mono text-xs text-cyan-300">STEP {step + 1} / 5</div>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">{intro.title}</h1>
              {intro.text && <p className="mt-2 max-w-3xl text-sm text-slate-400">{intro.text}</p>}
            </div>
            <StepView />
          </motion.section>
        </AnimatePresence>
      </main>

      <footer className="mx-auto max-w-7xl px-6 pb-8 text-center text-[11px] text-slate-500">
        Everything happens in your browser. Your audio never leaves this page.
      </footer>

      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 z-50 flex w-[min(92vw,620px)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-ink-800/95 p-4 text-sm text-slate-200 shadow-2xl ring-1 ring-cyan-400/40"
          >
            <Loader2 className="size-5 shrink-0 animate-spin text-cyan-300" />
            <span>{BUSY_TEXT[toast]}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 z-50 flex w-[min(92vw,560px)] -translate-x-1/2 items-start gap-3 rounded-2xl bg-rose-950/95 p-4 text-sm text-rose-100 shadow-2xl ring-1 ring-rose-400/40"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-300" />
            <span className="grow">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss" className="text-rose-300 hover:text-white">
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
