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
  { title: 'Choose your audio', text: 'Choose the normal audio that everyone will hear, then add the secret voice or text you want to hide.' },
  {
    title: 'Your secret is now hidden',
    text: 'Your secret has been embedded into the cover audio. Inspect the DSP steps below to see how it happened.',
  },
  { title: 'Send the audio', text: 'Imagine the hidden audio being sent to another person. Simulate noise, volume changes and quantisation to see whether the secret survives.' },
  {
    title: 'Recover the hidden message',
    text: 'Use the receiver key to recover the secret from the received audio. Technical decoder settings and visualisations are shown below.',
  },
  { title: 'Your secret has been recovered', text: 'Listen to what everyone hears and what the receiver can recover, then review the technical results.' },
]

const STEPS = [SenderStep, EncodeStep, ChannelStep, ReceiverStep, OutputStep]

const BUSY_TEXT = {
  encode: 'Hiding the secret — applying the FFT, FIR filtering and keyed spectral embedding…',
  channel: 'Sending the audio — applying channel gain, noise and 16-bit quantisation…',
  decode: 'Recovering the secret — applying FFT decoding, band extraction and keyed unscrambling…',
} as const

export default function App() {
  const { step, error, setError, busy, uiMode, setUIMode, goTo, encoded, encodeError } = useStegoStore()
  const [welcomeOpen, setWelcomeOpen] = useState(true)
  const StepView = STEPS[step]
  // The Encode step's heading follows the real run rather than assuming it already succeeded.
  const intro =
    step === 1 && !encoded
      ? busy === 'encode'
        ? { title: 'Hiding your secret…', text: 'The encoder is running in a Web Worker. Watch each block light up as the code reaches it.' }
        : encodeError
          ? { title: 'Encoding failed', text: 'Nothing was hidden. The reason is shown below.' }
          : { title: 'Ready to hide your secret', text: 'Start the encoder to embed your secret into the cover audio.' }
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
              <div className="text-[11px] text-slate-400">Audio-in-audio steganography · FFT band embedding · time reversal</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="text-right text-[10px] leading-tight text-slate-400" aria-live="polite">
              <div className="font-semibold text-slate-300">{uiMode === 'beginner' ? 'Beginner Mode' : 'DSP Mode'}</div>
              <div>{uiMode === 'beginner' ? 'Simple view — focus on what to do.' : 'Technical view — see the signal processing details.'}</div>
            </div>
            <div className="inline-flex rounded-xl bg-white/5 p-1 ring-1 ring-white/10" role="group" aria-label="Choose application view">
              <button
                type="button"
                aria-pressed={uiMode === 'beginner'}
                onClick={() => setUIMode('beginner')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:text-white aria-pressed:bg-cyan-400 aria-pressed:text-ink-950"
              >
                Beginner Mode
              </button>
              <button
                type="button"
                aria-pressed={uiMode === 'dsp'}
                onClick={() => setUIMode('dsp')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:text-white aria-pressed:bg-cyan-400 aria-pressed:text-ink-950"
              >
                DSP Mode
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
              <p className="mt-2 max-w-3xl text-sm text-slate-400">{intro.text}</p>
            </div>
            <StepView />
          </motion.section>
        </AnimatePresence>
      </main>

      <footer className="mx-auto max-w-7xl px-6 pb-8 text-center text-[11px] text-slate-500">
        All signal processing runs in your browser (TypeScript radix-2 FFT in a Web Worker). No audio leaves this page.
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
