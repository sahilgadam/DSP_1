import { ArrowLeft, ArrowRight, Cpu, Play, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { EncoderRunDiagram, useRunPlayback } from '../components/pipeline/encoder-run-diagram'
import { Button, Card, CardTitle } from '../components/ui/primitives'
import { useStegoStore } from '../store/use-stego-store'

const BEGINNER_HIDE_TOUR_STEPS: BeginnerTourStep[] = [
  {
    target: 'encode-run',
    title: 'What are we doing?',
    text: 'We are hiding the secret inside the cover audio.\n\nThe new audio still sounds like the original, but now carries the hidden information.',
  },
  {
    target: 'encode-run',
    title: 'How does it work?',
    text: 'Each block of the diagram is one step of the real encoder. Watch the signal move from block to block: the FFT turns the audio into frequencies, the secret is scrambled with your key, and it is placed high in the spectrum where the ear barely notices.',
  },
  {
    target: 'encode-action',
    title: 'Your turn',
    text: 'When the stego file is ready, send it through the simulated channel.',
  },
]

export function EncodeStep() {
  const { encoded, busy, encodeProgress, encodeError, encode, goTo, cover, secret, hiddenText, uiMode } = useStegoStore()
  const [tourOpen, setTourOpen] = useState(uiMode === 'beginner')
  const playback = useRunPlayback(encodeProgress)
  const running = busy === 'encode'
  const started = Object.keys(encodeProgress).length > 0
  const canRun = !!cover && (!!secret || hiddenText.trim().length > 0)
  const failed = !!encodeError && !running

  useEffect(() => {
    setTourOpen(uiMode === 'beginner')
  }, [uiMode])

  return (
    <div className="space-y-6">
      <div data-tour-target="encode-run">
        <Card>
          <CardTitle
            icon={<Cpu className="size-4" />}
            title="Encoder — live run"
            hint="The real encoder, block by block, in the order the code executes. The times are measured in the Web Worker; the playback is slowed down so every step can be followed."
            right={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void encode()}
                disabled={running || !canRun}
                icon={started ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}
              >
                {started ? 'Encode again' : 'Start encoding'}
              </Button>
            }
          />
          <EncoderRunDiagram
            progress={encodeProgress}
            failed={failed}
            error={encodeError}
            fftSize={encoded?.fftSize ?? null}
            playback={playback}
            keyCheckOnly={hiddenText.trim().length === 0}
          />
          {failed && (
            <div className="mt-4">
              <Button variant="secondary" size="sm" onClick={() => goTo(0)} icon={<ArrowLeft className="size-3.5" />}>
                Back to the sender
              </Button>
            </div>
          )}
        </Card>
      </div>

      <div data-tour-target="encode-action" className="flex justify-end pt-1">
        <Button size="lg" onClick={() => goTo(2)} disabled={!encoded} icon={<ArrowRight className="size-5" />}>
          Send the audio
        </Button>
      </div>
      <BeginnerTour open={uiMode === 'beginner' && tourOpen && playback.complete} steps={BEGINNER_HIDE_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
