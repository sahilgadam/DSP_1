/// <reference lib="webworker" />
import { correlation, energy, gainMatchedSnrDb, segmentalSnrDb, spectrogram, welchPsd } from '../dsp/analysis'
import { bitErrorRate, computeLaneLayout, frameBits, payloadCapacityBytes, type LaneReadout } from '../dsp/bit-lane'
import { applyChannelWithStats } from '../dsp/channel'
import { CRYPTO_OVERHEAD, decryptText, encryptText } from '../dsp/crypto'
import { gaussianNoise } from '../dsp/prng'
import { frequencyResponse } from '../dsp/fir'
import { decode, encode, fftSizeFor, stageTracker, type StageEvent } from '../dsp/stego'
import type {
  ChannelOutput,
  DecodeOutput,
  EncodeOutput,
  RecoveryMetrics,
  StageView,
  TextDecodeInfo,
  TextLaneInfo,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

declare const self: DedicatedWorkerGlobalScope

function view(samples: Float32Array, sampleRate: number): StageView {
  return { samples, psd: welchPsd(samples, sampleRate, 2048, 0, 96), spec: spectrogram(samples, sampleRate, 1024, 300) }
}

function views<K extends string>(stages: Record<K, Float32Array>, sampleRate: number): Record<K, StageView> {
  const out = {} as Record<K, StageView>
  for (const k of Object.keys(stages) as K[]) out[k] = view(stages[k], sampleRate)
  return out
}

function recoveryMetrics(reference: Float32Array | null, recovered: Float32Array): RecoveryMetrics | null {
  if (!reference) return null
  return {
    snrDb: gainMatchedSnrDb(reference, recovered),
    segSnrDb: segmentalSnrDb(reference, recovered),
    correlation: correlation(reference, recovered),
  }
}

/** Encrypts the text and frames it as bits for the lane of a clip of this length. */
async function prepareText(text: string, key: string, length: number, sampleRate: number, withVoice: boolean): Promise<TextLaneInfo | null> {
  if (text.trim().length === 0) return null
  const layout = computeLaneLayout(fftSizeFor(length), sampleRate)
  const cipher = await encryptText(text, key)
  const bits = frameBits(cipher, layout, withVoice)
  return {
    plaintext: text,
    cipher,
    bits,
    capacityBytes: payloadCapacityBytes(layout) - CRYPTO_OVERHEAD,
    usedBins: bits.length * layout.chipsPerBit,
    laneBins: layout.width,
    chipsPerBit: layout.chipsPerBit,
    laneLowHz: layout.start * layout.binHz,
    laneHighHz: (layout.start + layout.width) * layout.binHz,
  }
}

/** Evenly thins the constellation so the UI never draws more than ~1500 points. */
function thin(x: Float32Array, max = 1500): Float32Array {
  if (x.length <= max) return x.slice()
  const out = new Float32Array(max)
  for (let i = 0; i < max; i++) out[i] = x[Math.floor((i * x.length) / max)]
  return out
}

/** Despread symbols -> decrypted text, BER and a normalised constellation. */
async function readText(lane: LaneReadout, key: string, referenceBits: Uint8Array | null): Promise<TextDecodeInfo> {
  let status: TextDecodeInfo['status'] = lane.status
  let text: string | null = null
  if (lane.status === 'ok' && lane.payload) {
    try {
      text = await decryptText(lane.payload, key)
    } catch {
      status = 'auth-failed'
    }
  }
  // scale so a clean symbol sits at ±1
  const mags = Array.from(lane.softRe, Math.abs).sort((a, b) => a - b)
  const scale = mags[Math.floor(mags.length / 2)] || 1
  return {
    status,
    text,
    bits: lane.bits,
    // only an authenticated frame is trusted to say what was sent
    withVoice: status === 'ok' ? lane.withVoice : null,
    softRe: thin(lane.softRe.map((v) => v / scale)),
    softIm: thin(lane.softIm.map((v) => v / scale)),
    ber: referenceBits ? bitErrorRate(referenceBits, lane.bits) : null,
    headerLength: lane.headerLength,
  }
}

/** Collects every typed-array buffer so results move to the main thread without copying. */
function transferables(value: unknown, acc = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) acc.add(value.buffer)
  } else if (Array.isArray(value)) {
    value.forEach((v) => transferables(v, acc))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => transferables(v, acc))
  }
  return [...acc]
}

/**
 * Runs one full encode/decode on a synthetic 10 s clip so the JIT has compiled every hot loop and the
 * worker heap is already grown by the time the user presses Encode (the first real run is ~2x faster).
 */
function warmup(): null {
  const len = 10 * 44100
  const noise = gaussianNoise(len, 99)
  const tone = Float32Array.from({ length: len }, (_, i) => 0.3 * Math.sin(i * 0.11))
  const enc = encode(noise, tone, 44100, { key: 'warmup', strengthDb: -20, fftKind: 'dit' })
  decode(enc.stages.stego, 44100, { key: 'warmup', fftKind: 'dif', wrongKey: 'x' })
  view(enc.stages.stego, 44100)
  return null
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer)

async function handle(req: WorkerRequest): Promise<EncodeOutput | ChannelOutput | DecodeOutput | null> {
  const t0 = performance.now()
  switch (req.type) {
    case 'warmup':
      return warmup()
    case 'encode': {
      // every block reports when it starts and ends, so the UI can follow the real run as it happens
      const run: StageEvent[] = []
      const onStage = (e: StageEvent) => {
        if (e.status !== 'running') run.push(e)
        post({ id: req.id, progress: e })
      }
      const outer = stageTracker(onStage)
      let text: TextLaneInfo | null = null
      if (req.text.trim().length > 0) {
        outer.start('aes')
        text = await prepareText(req.text, req.params.key, req.cover.length, req.sampleRate, !!req.secret)
        outer.end()
      } else outer.skip('aes')
      const r = encode(req.cover, req.secret, req.sampleRate, { ...req.params, textBits: text?.bits ?? null }, onStage)
      const dspMs = performance.now() - t0
      const stego = r.stages.stego
      const hidden = r.stages['secret-shifted']
      outer.start('analysis')
      const stages = views(r.stages, req.sampleRate)
      const coverSnrDb = gainMatchedSnrDb(req.cover, stego)
      outer.end()
      return {
        stages,
        layout: r.layout,
        permutation: r.permutation,
        gain: r.gain,
        clipScale: r.clipScale,
        secretTruncated: r.secretTruncated,
        hasVoice: r.hasVoice,
        firResponse: frequencyResponse(r.fir, req.sampleRate, 600),
        metrics: {
          coverSnrDb,
          hiddenLevelDb: r.hasVoice ? 10 * Math.log10(energy(hidden) / Math.max(energy(stego), 1e-20)) : null,
        },
        totalMs: performance.now() - t0,
        timings: { dspMs, analysisMs: performance.now() - t0 - dspMs },
        text,
        run,
        fftSize: fftSizeFor(req.cover.length),
      }
    }
    case 'channel': {
      const seed = req.params.noiseSnrDb === null ? null : (req.params.seed ?? 1234)
      const { out: received, clipped } = applyChannelWithStats(req.stego, req.params)
      return {
        received: view(received, req.sampleRate),
        channelSnrDb: gainMatchedSnrDb(req.stego, received),
        levelChangeDb: 10 * Math.log10(Math.max(energy(received), 1e-20) / Math.max(energy(req.stego), 1e-20)),
        clippedSamples: clipped,
        noiseSeed: seed,
      }
    }
    case 'decode': {
      const wrongKeyStr = `${req.params.key}?`
      const r = decode(req.received, req.sampleRate, { ...req.params, wrongKey: wrongKeyStr })
      const wrongRecovered = r.wrongKeyRecovered ?? new Float32Array(req.received.length)
      const dspMs = performance.now() - t0
      const stages = views(r.stages, req.sampleRate)
      const text = await readText(r.lane, req.params.key, req.referenceBits)
      // an authenticated text-only frame proves the carrier band holds no voice, so nothing to score
      const voiceAbsent = text.withVoice === false
      return {
        stages,
        layout: r.layout,
        permutation: r.permutation,
        fftMs: r.fftMs,
        fftSize: r.fftSize,
        fftStages: r.fftStages,
        butterflyCount: r.butterflyCount,
        totalMs: performance.now() - t0,
        timings: { dspMs, analysisMs: performance.now() - t0 - dspMs },
        metrics: voiceAbsent ? null : recoveryMetrics(req.reference, r.stages.recovered),
        text,
        wrongKey: {
          key: wrongKeyStr,
          recovered: view(wrongRecovered, req.sampleRate),
          metrics: recoveryMetrics(req.reference, wrongRecovered),
          text: r.wrongLane ? await readText(r.wrongLane, wrongKeyStr, req.referenceBits) : null,
        },
      }
    }
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data
  try {
    const result = await handle(req)
    post({ id: req.id, ok: true, result }, result ? transferables(result) : [])
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
