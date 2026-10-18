import { CHIPS_PER_BIT, LANE_HIGH_HZ, LANE_LOW_HZ } from './constants'
import type { Spectrum } from './fft'
import { hashKey, mulberry32 } from './prng'

/**
 * Hidden bit lane — improved FFT phase coding.
 * Each bit is BPSK-coded (phase 0 for bit 0, phase π for bit 1) onto CHIPS_PER_BIT consecutive FFT bins
 * of the 20.1–21.9 kHz lane, multiplied by a key-seeded ±1 chip sequence (direct-sequence spread spectrum).
 * The receiver multiplies by the same chips and sums ("despreading"), gaining 10·log10(chips) dB of SNR.
 */

/** Sync byte of a frame sent together with a hidden voice. */
export const MAGIC = 0xa5
/** Sync byte of a frame sent without a voice: the carrier band holds only the cover's own audio. */
export const MAGIC_TEXT_ONLY = 0xa6
/**
 * Sync byte of a voice-only file. Its payload is the AES-GCM encryption of an empty text: a key-check
 * token, so the receiver can verify the key even when no text was sent.
 */
export const MAGIC_VOICE_ONLY = 0xa7

/** What travels with the frame: decides the sync byte. */
export type FrameContent = 'voice+text' | 'text' | 'voice'

const MAGIC_OF: Record<FrameContent, number> = { 'voice+text': MAGIC, text: MAGIC_TEXT_ONLY, voice: MAGIC_VOICE_ONLY }

function contentOf(magic: number): FrameContent | null {
  if (magic === MAGIC) return 'voice+text'
  if (magic === MAGIC_TEXT_ONLY) return 'text'
  if (magic === MAGIC_VOICE_ONLY) return 'voice'
  return null
}
/** Sync byte (8 bits) + payload length in bytes (16 bits). */
export const HEADER_BITS = 24

export interface LaneLayout {
  /** First FFT bin of the lane. */
  start: number
  /** Lane width in bins. */
  width: number
  chipsPerBit: number
  /** Total bits the lane can carry (header included). */
  capacityBits: number
  binHz: number
}

export function computeLaneLayout(n: number, sampleRate: number): LaneLayout {
  const binHz = sampleRate / n
  const start = Math.round(LANE_LOW_HZ / binHz)
  const end = Math.round(LANE_HIGH_HZ / binHz)
  if (end >= n / 2) throw new Error(`Text lane exceeds Nyquist (sample rate ${sampleRate} Hz is too low)`)
  const width = end - start
  return { start, width, chipsPerBit: CHIPS_PER_BIT, capacityBits: Math.floor(width / CHIPS_PER_BIT), binHz }
}

/** Largest payload (bytes) that fits after the header. */
export function payloadCapacityBytes(layout: LaneLayout): number {
  return Math.max(0, Math.floor((layout.capacityBits - HEADER_BITS) / 8))
}

export function bytesToBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8)
  bytes.forEach((b, i) => {
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >> (7 - j)) & 1
  })
  return bits
}

export function bitsToBytes(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < out.length; i++) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]
    out[i] = v
  }
  return out
}

/** Header (magic + 16-bit length) followed by the payload, as a 0/1 bit array. */
export function frameBits(payload: Uint8Array, layout: LaneLayout, content: FrameContent = 'voice+text'): Uint8Array {
  if (payload.length > 0xffff) throw new Error('Payload too large')
  const capacity = payloadCapacityBytes(layout)
  if (payload.length > capacity) {
    throw new Error(`Hidden text needs ${payload.length} bytes but this cover can carry only ${capacity}. Use a shorter message or a longer cover.`)
  }
  const header = Uint8Array.of(MAGIC_OF[content], payload.length >> 8, payload.length & 0xff)
  const bytes = new Uint8Array(header.length + payload.length)
  bytes.set(header, 0)
  bytes.set(payload, header.length)
  return bytesToBits(bytes)
}

/** Key-seeded ±1 chip sequence (independent of the sub-band permutation stream). */
export function chipSequence(key: string, count: number): Int8Array {
  const rand = mulberry32(hashKey(`${key}#chips`))
  const out = new Int8Array(count)
  for (let i = 0; i < count; i++) out[i] = rand() < 0.5 ? -1 : 1
  return out
}

/**
 * Writes the spread BPSK symbols into the lane of `spec` (and the Hermitian mirror).
 * Symbol = +a for bit 0, −a for bit 1, times the chip; the values are real, so the mirror is identical.
 */
export function writeLane(spec: Spectrum, layout: LaneLayout, bits: Uint8Array, key: string, amplitude: number): void {
  const { n } = spec
  const used = bits.length * layout.chipsPerBit
  if (used > layout.width) throw new Error('Bitstream does not fit in the lane')
  const chips = chipSequence(key, used)
  for (let i = 0; i < bits.length; i++) {
    const symbol = bits[i] ? -amplitude : amplitude
    for (let c = 0; c < layout.chipsPerBit; c++) {
      const j = i * layout.chipsPerBit + c
      const k = layout.start + j
      const v = symbol * chips[j]
      spec.re[k] = v
      spec.im[k] = 0
      spec.re[n - k] = v
      spec.im[n - k] = 0
    }
  }
}

/** Per-bin amplitude so the *full* lane would sit `levelDb` below a cover of energy `coverEnergy`. */
export function laneAmplitude(coverEnergy: number, layout: LaneLayout, n: number, levelDb: number): number {
  // time-domain energy of 2·width real bins of amplitude a is (2·width·a²)/n  (Parseval)
  return Math.sqrt((coverEnergy * 10 ** (levelDb / 10) * n) / (2 * layout.width))
}

export type LaneStatus = 'ok' | 'no-payload'

export interface LaneReadout {
  status: LaneStatus
  /** Despread complex value of every bit read (header + payload): the BPSK constellation. */
  softRe: Float32Array
  softIm: Float32Array
  bits: Uint8Array
  /** Payload bytes when the header was valid. */
  payload: Uint8Array | null
  headerMagic: number
  headerLength: number
  /** What the sync byte says was sent; null when no frame synchronised. */
  content: FrameContent | null
}

function despread(spec: Spectrum, layout: LaneLayout, chips: Int8Array, bitIndex: number): [number, number] {
  let re = 0
  let im = 0
  for (let c = 0; c < layout.chipsPerBit; c++) {
    const j = bitIndex * layout.chipsPerBit + c
    const k = layout.start + j
    re += chips[j] * spec.re[k]
    im += chips[j] * spec.im[k]
  }
  return [re / layout.chipsPerBit, im / layout.chipsPerBit]
}

/** Despreads the header, validates it, then reads exactly the announced payload. */
export function readLane(spec: Spectrum, layout: LaneLayout, key: string): LaneReadout {
  const chips = chipSequence(key, layout.capacityBits * layout.chipsPerBit)
  const readBits = (from: number, count: number) => {
    const re = new Float32Array(count)
    const im = new Float32Array(count)
    const bits = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      const [r, m] = despread(spec, layout, chips, from + i)
      re[i] = r
      im[i] = m
      bits[i] = r < 0 ? 1 : 0
    }
    return { re, im, bits }
  }

  const header = readBits(0, HEADER_BITS)
  const hb = bitsToBytes(header.bits)
  const magic = hb[0]
  const length = (hb[1] << 8) | hb[2]
  const fits = HEADER_BITS + length * 8 <= layout.capacityBits
  const content = contentOf(magic)
  if (!content || length === 0 || !fits) {
    return { status: 'no-payload', softRe: header.re, softIm: header.im, bits: header.bits, payload: null, headerMagic: magic, headerLength: length, content: null }
  }
  const body = readBits(HEADER_BITS, length * 8)
  const softRe = new Float32Array(HEADER_BITS + length * 8)
  const softIm = new Float32Array(HEADER_BITS + length * 8)
  const bits = new Uint8Array(HEADER_BITS + length * 8)
  softRe.set(header.re)
  softRe.set(body.re, HEADER_BITS)
  softIm.set(header.im)
  softIm.set(body.im, HEADER_BITS)
  bits.set(header.bits)
  bits.set(body.bits, HEADER_BITS)
  return { status: 'ok', softRe, softIm, bits, payload: bitsToBytes(body.bits), headerMagic: magic, headerLength: length, content }
}

/** Fraction of differing bits over the overlapping length. */
export function bitErrorRate(sent: Uint8Array, received: Uint8Array): { errors: number; compared: number; ber: number } {
  const compared = Math.min(sent.length, received.length)
  let errors = 0
  for (let i = 0; i < compared; i++) if (sent[i] !== received[i]) errors++
  return { errors, compared, ber: compared ? errors / compared : 0 }
}
