import { energy } from './analysis'
import { gaussianNoise } from './prng'

export interface ChannelParams {
  /** Additive white Gaussian noise level relative to the signal, or null for a clean channel. */
  noiseSnrDb: number | null
  /** Simulate saving/sending as a standard 16-bit PCM WAV. */
  quantize16: boolean
  /** Volume change applied by the channel, in dB. */
  gainDb: number
  seed?: number
}

export const CLEAN_CHANNEL: ChannelParams = { noiseSnrDb: null, quantize16: true, gainDb: 0 }

/** Simulates transmission: volume change, AWGN, then 16-bit quantisation (with clipping). */
export function applyChannel(x: Float32Array, params: ChannelParams): Float32Array {
  return applyChannelWithStats(x, params).out
}

/** `applyChannel`, also counting the samples that ended up beyond full scale (clipped by a 16-bit file). */
export function applyChannelWithStats(x: Float32Array, params: ChannelParams): { out: Float32Array; clipped: number } {
  const g = 10 ** (params.gainDb / 20)
  const out = x.map((v) => v * g)
  if (params.noiseSnrDb !== null) {
    const sigPow = energy(out) / out.length
    const noiseStd = Math.sqrt(sigPow / 10 ** (params.noiseSnrDb / 10))
    const noise = gaussianNoise(out.length, params.seed ?? 1234)
    for (let i = 0; i < out.length; i++) out[i] += noiseStd * noise[i]
  }
  let clipped = 0
  for (let i = 0; i < out.length; i++) if (out[i] > 1 || out[i] < -1) clipped++
  if (params.quantize16) {
    for (let i = 0; i < out.length; i++) {
      const c = Math.max(-1, Math.min(1, out[i]))
      out[i] = Math.round(c * 32767) / 32767
    }
  }
  return { out, clipped }
}
