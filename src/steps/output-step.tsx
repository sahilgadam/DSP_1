import { Check, Copy, MessageSquareText, RotateCcw, Volume2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { WaveformPlayer } from '../components/audio/waveform-player'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { Button, Card, CardTitle } from '../components/ui/primitives'
import { useStegoStore } from '../store/use-stego-store'

const BEGINNER_OUTPUT_TOUR_STEPS: BeginnerTourStep[] = [
  {
    target: 'results-message',
    title: 'The hidden message',
    text: 'This is what the sender hid. Only someone with the right key gets here: the key was checked before anything was revealed.',
  },
]

/** The recovered message, and nothing else: a voice message, a text message, or both if both were sent. */
export function OutputStep() {
  const { decoded, goTo, uiMode } = useStegoStore()
  const [tourOpen, setTourOpen] = useState(uiMode === 'beginner')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setTourOpen(uiMode === 'beginner')
  }, [uiMode])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  // Results are reachable only after the key verified, but never show anything unverified.
  if (!decoded || decoded.text.status !== 'ok') return null
  const content = decoded.text.content
  const showVoice = content === 'voice' || content === 'voice+text'
  const text = content === 'text' || content === 'voice+text' ? decoded.text.text : null

  const copy = async () => {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-6">
      <div data-tour-target="results-message" className="space-y-6">
        {showVoice && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="ring-1 ring-emerald-400/40">
              <CardTitle icon={<Volume2 className="size-4" />} title="Voice message" hint="The secret voice, recovered from the received audio." />
              <WaveformPlayer
                samples={decoded.stages.recovered.samples}
                color="emerald"
                label="recovered voice message"
                height={96}
                downloadName="recovered-voice.wav"
                normalize
              />
            </Card>
          </motion.div>
        )}

        {text !== null && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: showVoice ? 0.1 : 0 }}>
            <Card className="ring-1 ring-violet-400/40">
              <CardTitle
                icon={<MessageSquareText className="size-4" />}
                title="Text message"
                hint="Decrypted and authenticated with AES-256-GCM."
                right={
                  <Button variant="secondary" size="sm" onClick={() => void copy()} icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                }
              />
              <p className="whitespace-pre-wrap break-words rounded-xl bg-black/30 px-5 py-4 font-mono text-lg leading-relaxed text-white ring-1 ring-white/10">{text}</p>
            </Card>
          </motion.div>
        )}
      </div>

      <div className="flex flex-wrap justify-between gap-3">
        <Button variant="secondary" onClick={() => goTo(3)}>
          Back to receiver
        </Button>
        <Button variant="secondary" onClick={() => goTo(0)} icon={<RotateCcw className="size-4" />}>
          Hide another message
        </Button>
      </div>
      <BeginnerTour open={uiMode === 'beginner' && tourOpen} steps={BEGINNER_OUTPUT_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
