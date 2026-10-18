import type { Psd, Spectrogram } from '../dsp/analysis'
import type { FrameContent } from '../dsp/bit-lane'
import type { ChannelParams } from '../dsp/channel'
import type { FrequencyResponse } from '../dsp/fir'
import type { BandLayout } from '../dsp/spectral-ops'
import type { DecodeParams, DecodeStageId, EncodeParams, EncodeStageId, StageEvent } from '../dsp/stego'

/** Audio of one pipeline stage plus what the UI needs to draw it. */
export interface StageView {
  samples: Float32Array
  psd: Psd
  spec: Spectrogram
}

/** What the sender put into the hidden text lane. */
export interface TextLaneInfo {
  plaintext: string
  /** Encrypted frame: salt | iv | ciphertext | tag. */
  cipher: Uint8Array
  /** Header + ciphertext as 0/1 bits (what is BPSK-modulated). */
  bits: Uint8Array
  capacityBytes: number
  usedBins: number
  laneBins: number
  chipsPerBit: number
  laneLowHz: number
  laneHighHz: number
}

export type TextStatus = 'ok' | 'no-payload' | 'auth-failed'

/** What the receiver got out of the text lane. */
export interface TextDecodeInfo {
  status: TextStatus
  text: string | null
  /** Bits read (header + payload). */
  bits: Uint8Array
  /** What the authenticated frame says was sent; null when nothing authenticated. */
  content: FrameContent | null
  /** Despread symbols (normalised), at most ~1500 points, for the constellation plot. */
  softRe: Float32Array
  softIm: Float32Array
  ber: { errors: number; compared: number; ber: number } | null
  headerLength: number
}

export interface EncodeOutput {
  stages: Record<EncodeStageId, StageView>
  layout: BandLayout
  permutation: number[]
  gain: number
  clipScale: number
  secretTruncated: boolean
  /** False for a text-only payload. */
  hasVoice: boolean
  firResponse: FrequencyResponse
  metrics: {
    /** SNR of the stego file against the original cover (gain matched). */
    coverSnrDb: number
    /** Actual level of the hidden band relative to the stego file (null when no voice was hidden). */
    hiddenLevelDb: number | null
  }
  totalMs: number
  timings: Timings
  text: TextLaneInfo | null
  /** Every block the encoder ran, in execution order, with its measured duration. */
  run: StageEvent[]
  fftSize: number
}

/** Where the worker spent its time (ms). */
export interface Timings {
  dspMs: number
  analysisMs: number
}

export interface ChannelOutput {
  received: StageView
  /**
   * SNR of the received file against the clean stego file after a least-squares gain match, so a pure
   * volume change does not count as damage (noise and quantisation do).
   */
  channelSnrDb: number
  /** Level of the received file relative to the sent one (dB). */
  levelChangeDb: number
  /** Samples that went past full scale (±1) and were clipped by the 16-bit file. */
  clippedSamples: number
  /** Noise realisation actually used (null on a noiseless channel). */
  noiseSeed: number | null
}

export interface RecoveryMetrics {
  snrDb: number
  segSnrDb: number
  correlation: number
}

export interface DecodeOutput {
  stages: Record<DecodeStageId, StageView>
  layout: BandLayout
  permutation: number[]
  fftMs: number
  fftSize: number
  fftStages: number
  butterflyCount: number
  totalMs: number
  timings: Timings
  metrics: RecoveryMetrics | null
  text: TextDecodeInfo
  wrongKey: { key: string; recovered: StageView; metrics: RecoveryMetrics | null; text: TextDecodeInfo | null }
}

export type WorkerRequest =
  | { type: 'warmup'; id: number }
  | {
      type: 'encode'
      id: number
      cover: Float32Array
      /** Null for a text-only payload. */
      secret: Float32Array | null
      sampleRate: number
      params: EncodeParams
      /** Hidden text to encrypt into the bit lane ('' = none). */
      text: string
    }
  | { type: 'channel'; id: number; stego: Float32Array; sampleRate: number; params: ChannelParams }
  | {
      type: 'decode'
      id: number
      received: Float32Array
      sampleRate: number
      params: DecodeParams
      reference: Float32Array | null
      /** Bits the sender embedded, to measure the bit error rate. */
      referenceBits: Uint8Array | null
    }

export type WorkerResponse =
  /** Streamed while an encode runs: one event per block start/end. */
  | { id: number; progress: StageEvent }
  | { id: number; ok: true; result: EncodeOutput | ChannelOutput | DecodeOutput | null }
  | { id: number; ok: false; error: string }
