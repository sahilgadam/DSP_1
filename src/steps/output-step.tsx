import { Ear, Lock, MessageSquareLock, RotateCcw, ShieldAlert, Volume2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { WaveformPlayer } from '../components/audio/waveform-player'
import { SpectrogramCanvas, specMax } from '../components/charts/spectrogram-canvas'
import { BeginnerTour, type BeginnerTourStep } from '../components/layout/beginner-tour'
import { marksFor } from '../components/pipeline/stage-inspector'
import { TextDecodePanel, TextStatusBanner } from '../components/text-lane/text-result'
import { Button, Card, CardTitle, fmtDb, Metric } from '../components/ui/primitives'
import { useStegoStore } from '../store/use-stego-store'

const BEGINNER_OUTPUT_TOUR_STEPS: BeginnerTourStep[] = [
  { target: 'results-overview', title: 'What are we looking at?', text: 'We are comparing the original and recovered results.\n\nThis lets us see whether the hidden information survived the complete transmission and decoding process.' },
  { target: 'results-recovered', title: 'Why are we comparing them?', text: 'A successful steganography system should recover the hidden information while keeping the cover audio close to its original form.\n\nThe comparison helps us evaluate how well the system worked.' },
  { target: 'results-technical', title: 'How do we evaluate the result?', text: 'We can compare the waveforms and frequency spectra, listen to the recovered audio and inspect the available signal-quality metrics.\n\nThese give us both a visual and numerical view of the result.' },
  { target: 'results-recovered', title: 'Your turn', text: 'Listen to the recovered audio and compare it with the original.\n\nYou can also inspect the spectrum, spectrogram and metrics to understand what happened during the experiment.' },
]

export function OutputStep() {
  const { encoded, decoded, transmitted, receivedFile, goTo, uiMode } = useStegoStore()
  const [tourOpen, setTourOpen] = useState(uiMode === 'beginner')
  useEffect(() => {
    setTourOpen(uiMode === 'beginner')
  }, [uiMode])
  if (!decoded) return null
  const stego = receivedFile?.samples ?? transmitted?.received.samples ?? decoded.stages.received.samples
  const m = decoded.metrics
  const wk = decoded.wrongKey
  // The sender's signals are only a fair comparison for a file this session's encoder produced.
  const sameRun = encoded && encoded.stages.stego.samples.length === decoded.stages.received.samples.length ? encoded : null
  const status = decoded.text.status
  /** An authenticated text-only frame proves there is no voice to listen to. */
  const noVoice = decoded.text.withVoice === false
  const voiceHint =
    status === 'ok'
      ? 'Recovered with the key you entered. The key is verified: the text lane authenticated with it.'
      : status === 'auth-failed'
        ? 'The key did not verify against the text lane, so this is most likely still scrambled.'
        : 'No text lane to verify the key against. Listen: intelligible speech means the key was right.'
  const coverMax = sameRun ? Math.max(specMax(sameRun.stages.cover.spec), specMax(sameRun.stages.stego.spec)) : undefined
  const secretMax = sameRun?.hasVoice ? specMax(sameRun.stages['secret-bandlimited'].spec) : undefined

  return (
    <div className="space-y-6">
      <div data-tour-target="results-overview" className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="h-full ring-1 ring-cyan-400/30">
            <CardTitle icon={<Ear className="size-4" />} title="What everyone hears" hint="Normal audio — the hidden message should not be audible." />
            <WaveformPlayer samples={stego} color="cyan" label="received stego audio" height={88} downloadName="stego-received.wav" />
          </Card>
        </motion.div>
        <motion.div data-tour-target="results-recovered" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card className={status === 'ok' ? 'h-full ring-1 ring-emerald-400/40' : status === 'auth-failed' ? 'h-full ring-1 ring-rose-400/40' : 'h-full ring-1 ring-amber-400/40'}>
            {noVoice ? (
              <>
                <CardTitle icon={<Volume2 className="size-4" />} title="What the receiver hears" hint="No voice was hidden in this file." />
                <p className="text-sm leading-relaxed text-slate-300">
                  The authenticated frame says the sender hid text only, so the 16.5–19.9 kHz band holds nothing but the cover’s own audio. The message is the text below.
                </p>
              </>
            ) : (
              <>
                <CardTitle icon={<Volume2 className="size-4" />} title="What the receiver hears" hint={voiceHint} />
                <WaveformPlayer samples={decoded.stages.recovered.samples} color="emerald" label="recovered secret" height={88} downloadName="recovered-secret.wav" normalize />
              </>
            )}
          </Card>
        </motion.div>
      </div>

      {(decoded.text.status !== 'no-payload' || sameRun?.text) && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Card className="ring-1 ring-violet-400/40">
            <CardTitle
              icon={<MessageSquareLock className="size-4" />}
              title="Recovered secret text"
              hint="Read from the 20.1–21.9 kHz lane of the same FFT: despread, BPSK decision, AES-GCM decryption."
            />
            <TextDecodePanel info={decoded.text} sent={sameRun?.text ?? null} />
          </Card>
        </motion.div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {sameRun && <Metric label="Cover vs stego SNR" value={fmtDb(sameRun.metrics.coverSnrDb)} unit="dB" hint="Whole-band, gain matched: the hidden lanes and the band-stop count as error" />}
        {m && <Metric label="Recovered SNR" value={fmtDb(m.snrDb)} unit="dB" tone="emerald" hint="vs. band-limited original (gain matched)" />}
        {m && <Metric label="Segmental SNR" value={fmtDb(m.segSnrDb)} unit="dB" tone="emerald" hint="Frame-averaged, tracks speech quality" />}
        {m && <Metric label="Correlation" value={m.correlation.toFixed(3)} tone="violet" hint="1.000 = identical waveform" />}
        <Metric label="Decode FFT" value={decoded.fftMs.toFixed(1)} unit="ms" tone="amber" hint={`${decoded.butterflyCount.toLocaleString('en-US')} butterflies`} />
      </div>
      {!m && (
        <p className="text-xs text-slate-400">
          {noVoice
            ? 'No voice was hidden, so there is no recovered voice to score.'
            : 'Voice quality metrics need the original secret, so they are only shown when this file came from this session’s encoder.'}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card data-tour-target="results-technical">
          <CardTitle title="Technical results" hint="Compare the original and recovered signals, spectra and metrics below." />
          {sameRun?.hasVoice && <WaveformPlayer samples={sameRun.stages['secret-bandlimited'].samples} color="violet" label="original secret (300–3400 Hz)" normalize compact />}
          {!noVoice && (
            <div className="mt-3">
              <WaveformPlayer
                samples={decoded.stages.deinverted.samples}
                color="amber"
                label="before the final time reversal — the message played backwards"
                normalize
                compact
              />
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 [&>*]:min-w-0">
            {sameRun?.hasVoice && <SpectrogramCanvas spec={sameRun.stages['secret-bandlimited'].spec} title="Original" dbMax={secretMax} height={150} />}
            <SpectrogramCanvas spec={decoded.stages.recovered.spec} title={noVoice ? 'Carrier band, shifted down' : 'Recovered'} height={150} />
          </div>
        </Card>

        <Card>
          <CardTitle title="Cover vs stego spectrogram" hint="Same colour scale. The secret lives in the dashed carrier band." />
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            {sameRun && <SpectrogramCanvas spec={sameRun.stages.cover.spec} title="Original cover" dbMax={coverMax} height={330} />}
            <SpectrogramCanvas spec={decoded.stages.received.spec} title="Received stego" dbMax={coverMax} height={330} marks={marksFor(decoded.layout)} />
          </div>
        </Card>
      </div>

      <Card className="ring-1 ring-rose-400/30">
        <CardTitle
          icon={<ShieldAlert className="size-4 text-rose-300" />}
          title="Compare: the same audio with a different key"
          hint="Decoded again with your key plus one extra character, to show how much the key matters."
        />
        <div className={noVoice ? 'grid gap-6' : 'grid gap-6 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0'}>
          <div className={noVoice ? 'hidden' : 'space-y-3'}>
            <WaveformPlayer samples={wk.recovered.samples} color="rose" label="output with the different key" normalize />
            {wk.metrics && (
              <div className="grid grid-cols-3 gap-3">
                <Metric label="SNR" value={fmtDb(wk.metrics.snrDb)} unit="dB" tone="rose" />
                <Metric label="Seg. SNR" value={fmtDb(wk.metrics.segSnrDb)} unit="dB" tone="rose" />
                <Metric label="Correlation" value={wk.metrics.correlation.toFixed(3)} tone="rose" />
              </div>
            )}
            <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              The FFT, band-pass, inversion and time reversal are all undone correctly; only the 16 sub-bands stay in the wrong order. That alone is enough
              to make the speech unintelligible.
            </p>
          </div>
          <div className="space-y-3">
            {!noVoice && <SpectrogramCanvas spec={wk.recovered.spec} title="Different-key output" height={180} />}
            {wk.text && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-slate-300">Hidden text with the different key</div>
                <TextStatusBanner info={wk.text} />
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="flex justify-between">
        <Button variant="secondary" onClick={() => goTo(3)}>
          Back to receiver
        </Button>
        <Button variant="secondary" onClick={() => goTo(0)} icon={<RotateCcw className="size-4" />}>
          Try other audio
        </Button>
      </div>
      <BeginnerTour open={uiMode === 'beginner' && tourOpen} steps={BEGINNER_OUTPUT_TOUR_STEPS} onClose={() => setTourOpen(false)} />
    </div>
  )
}
