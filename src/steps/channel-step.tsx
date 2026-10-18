import { ArrowRight, Send, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WaveformPlayer } from '../components/audio/waveform-player'
import { TransmissionAnimation } from '../components/channel/transmission-animation'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { Button, Card, CardTitle, fmtDb, Metric, Slider, Switch } from '../components/ui/primitives'
import { useStegoStore } from '../store/use-stego-store'

const MIN_ANIMATION_MS = 2200

const BEGINNER_CHANNEL_TOUR_STEPS: BeginnerTourStep[] = [
  { target: 'channel-overview', title: 'What are we doing?', text: 'We are simulating what happens when the encoded audio is transmitted through a communication channel.\n\nThe encoded audio now travels from the sender toward the receiver.' },
  { target: 'channel-controls', title: 'Why are we doing this?', text: 'Real communication systems are not perfect.\n\nNoise, quantization and changes in signal level can affect the received audio. We simulate these effects to see whether the hidden information can still be recovered.' },
  { target: 'channel-metrics', title: 'How does it work?', text: 'We apply controlled changes to the encoded signal and observe how the received signal differs from the transmitted signal.\n\nThe Signal-to-Noise Ratio, or SNR, helps us measure the strength of the useful signal compared with noise.' },
  { target: 'channel-action', title: 'Your turn', text: 'Try the channel settings and transmit the encoded audio.\n\nAfter transmission, we will use the received signal to recover the hidden information.' },
]

export function ChannelStep() {
  const { channel, setChannel, transmit, transmitted, busy, goTo, uiMode } = useStegoStore()
  const [animating, setAnimating] = useState(false)
  const [tourOpen, setTourOpen] = useState(uiMode === 'beginner')
  const noisy = channel.noiseSnrDb !== null

  useEffect(() => {
    setTourOpen(uiMode === 'beginner')
  }, [uiMode])

  useEffect(() => {
    if (!animating) return
    const t = setTimeout(() => setAnimating(false), MIN_ANIMATION_MS)
    return () => clearTimeout(t)
  }, [animating])

  const send = async () => {
    setAnimating(true)
    await transmit()
  }

  const sending = animating || busy === 'channel'
  const delivered = !!transmitted && !sending

  return (
    <div className="space-y-6">
      <div data-tour-target="channel-overview">
        <TransmissionAnimation active={sending} delivered={delivered} noisy={noisy} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card data-tour-target="channel-controls">
          <CardTitle
            icon={<SlidersHorizontal className="size-4" />}
            title="Channel Settings"
          />
          <div className="space-y-5">
            <Switch checked={channel.quantize16} onChange={(v) => setChannel({ quantize16: v })} label="Save as a standard 16-bit WAV" />
            <Switch checked={noisy} onChange={(v) => setChannel({ noiseSnrDb: v ? 30 : null })} label="Add some noise" />
            <Slider
              label="How much noise"
              value={channel.noiseSnrDb ?? 30}
              min={0}
              max={60}
              step={1}
              disabled={!noisy}
              onChange={(v) => setChannel({ noiseSnrDb: v })}
              format={(v) => `${v} dB`}
            />
            <Slider label="Volume change" value={channel.gainDb} min={-20} max={6} step={1} onChange={(v) => setChannel({ gainDb: v })} format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
            <Button data-tour-target="channel-action" className="w-full" size="lg" onClick={send} loading={sending} icon={<Send className="size-4" />}>
              {transmitted ? 'Transmit Again' : 'Transmit'}
            </Button>
          </div>
        </Card>

        <Card data-tour-target="channel-metrics">
          <CardTitle title="Received Audio" />
          {delivered && transmitted ? (
            <div className="space-y-4">
              <WaveformPlayer samples={transmitted.received.samples} color="cyan" label="received.wav" downloadName="received.wav" height={72} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric label="Signal quality" value={fmtDb(transmitted.channelSnrDb)} unit="dB SNR" />
                <Metric
                  label="Volume change"
                  value={`${transmitted.levelChangeDb > 0.05 ? '+' : ''}${transmitted.levelChangeDb.toFixed(1)}`}
                  unit="dB"
                  tone="violet"
                />
              </div>
              {transmitted.clippedSamples > 0 && (
                <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-100 ring-1 ring-amber-400/30">
                  Too loud: {transmitted.clippedSamples.toLocaleString('en-US')} samples clipped. That can damage the secret.
                </p>
              )}
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/15 text-sm text-slate-500">
              {sending ? 'On its way…' : 'Nothing yet. Hit send.'}
            </div>
          )}
        </Card>
      </div>

      <div className="flex justify-end">
        <Button size="lg" onClick={() => goTo(3)} disabled={!delivered} icon={<ArrowRight className="size-5" />}>
          Continue to Decoding
        </Button>
      </div>
      <BeginnerTour open={uiMode === 'beginner' && tourOpen} steps={BEGINNER_CHANNEL_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
