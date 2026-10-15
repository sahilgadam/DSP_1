import { describe, expect, it } from 'vitest'
import type { AudioClip } from '../audio/load-audio'
import { computeLaneLayout, frameBits } from '../dsp/bit-lane'
import { SAMPLE_RATE } from '../dsp/constants'
import { encryptText } from '../dsp/crypto'
import { encode, fftSizeFor } from '../dsp/stego'
import { checkReceivedAudio, checkReceiverKey, recoveryVerdict } from './receiver-validation'

const KEY = 'receiver-test-2026'
const SECONDS = 8

function clip(samples: Float32Array, name = 'received.wav'): AudioClip {
  return { name, samples, duration: samples.length / SAMPLE_RATE, truncated: false }
}

function music(n: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t) + 0.08 * Math.sin(2 * Math.PI * 3000 * t)
  }
  return x
}

function speech(n: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    x[i] = 0.5 * Math.sin(2 * Math.PI * 900 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t))
  }
  return x
}

/** A real stego signal, built by the encoder the receiver will have to mirror. */
async function stego(): Promise<Float32Array> {
  const n = Math.round(SECONDS * SAMPLE_RATE)
  const layout = computeLaneLayout(fftSizeFor(n), SAMPLE_RATE)
  const bits = frameBits(await encryptText('hello from the sender', KEY), layout)
  return encode(music(n), speech(n), SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: bits }).stages.stego
}

/** Crude low-pass, standing in for what MP3 or a voice note does to the top of the spectrum. */
function lowPass(x: Float32Array): Float32Array {
  const out = Float32Array.from(x)
  let prev = 0
  for (let pass = 0; pass < 8; pass++) for (let i = 0; i < out.length; i++) { prev += 0.25 * (out[i] - prev); out[i] = prev }
  return out
}

describe('checkReceivedAudio', () => {
  it('accepts a real stego file', async () => {
    expect(checkReceivedAudio(clip(await stego()))).toEqual({ error: null, warning: null })
  })

  it('accepts an ordinary recording too — presence of a message cannot be judged before decoding', () => {
    expect(checkReceivedAudio(clip(music(Math.round(SECONDS * SAMPLE_RATE)), 'just-music.wav')).error).toBeNull()
  })

  it('accepts a stego file whose top band was stripped, leaving the verdict to the decoder', async () => {
    expect(checkReceivedAudio(clip(lowPass(await stego()), 'stego-as-mp3.wav')).error).toBeNull()
  })

  it('rejects silent audio', () => {
    expect(checkReceivedAudio(clip(new Float32Array(SAMPLE_RATE))).error).toMatch(/silent/i)
  })

  it('rejects an empty clip', () => {
    expect(checkReceivedAudio(clip(new Float32Array(0))).error).toMatch(/zero samples/i)
  })

  it('accepts even a tiny clip: at 44.1 kHz the decoder layout still resolves, so only the decode can judge it', () => {
    // computeLayout() only throws below ~207 samples of FFT size, which 44.1 kHz never reaches here.
    expect(checkReceivedAudio(clip(new Float32Array(8).fill(0.5))).error).toBeNull()
  })

  it('warns when the file was trimmed on load', async () => {
    const long = { ...clip(await stego()), truncated: true }
    expect(checkReceivedAudio(long).warning).toMatch(/first \d+ s/i)
  })

  it('says nothing when no file is loaded', () => {
    expect(checkReceivedAudio(null)).toEqual({ error: null, warning: null })
  })
})

describe('checkReceiverKey', () => {
  it('requires a key', () => {
    expect(checkReceiverKey('').error).toMatch(/enter the key/i)
    expect(checkReceiverKey('   ').error).toMatch(/enter the key/i)
  })

  it('accepts an ordinary key', () => {
    expect(checkReceiverKey(KEY)).toEqual({ error: null, warning: null })
  })

  it('warns about padding spaces without blocking', () => {
    const check = checkReceiverKey(' dsp-cie-2026 ')
    expect(check.error).toBeNull()
    expect(check.warning).toMatch(/space/i)
  })
})

describe('recoveryVerdict', () => {
  it('only claims the key is verified when GCM authenticated', () => {
    expect(recoveryVerdict('ok').tone).toBe('ok')
    expect(recoveryVerdict('ok').title).toMatch(/verified/i)
  })

  it('blames the key or the file when the tag fails', () => {
    expect(recoveryVerdict('auth-failed').tone).toBe('bad')
    expect(recoveryVerdict('auth-failed').detail).toMatch(/typos|altered|re-encoded/i)
  })

  it('stays non-committal when no lane synced, since voice-only sends look the same', () => {
    const v = recoveryVerdict('no-payload')
    expect(v.tone).toBe('unsure')
    expect(v.detail).toMatch(/voice only/i)
  })
})
