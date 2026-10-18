import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gainMatchedSnrDb } from './analysis'
import { computeLaneLayout, frameBits, MAGIC, MAGIC_TEXT_ONLY, MAGIC_VOICE_ONLY, bitsToBytes, type FrameContent } from './bit-lane'
import { applyChannelWithStats, CLEAN_CHANNEL } from './channel'
import { SAMPLE_RATE } from './constants'
import { decryptText, encryptText } from './crypto'
import { decode, encode, ENCODE_RUN_STAGES, fftSizeFor, reverseInFrequency, type StageEvent } from './stego'
import { inverseRealFft, realFft } from './fft'
import { decodeWav16 } from './wav'

function loadSample(name: string): Float32Array {
  const path = fileURLToPath(new URL(`../../public/samples/${name}`, import.meta.url))
  const b = readFileSync(path)
  return decodeWav16(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).samples
}

const cover = loadSample('cover-demo.wav')
const secret = loadSample('secret-demo.wav')
const KEY = 'payload-modes-2026'

async function textBits(text: string, withVoice: boolean, content: FrameContent = withVoice ? 'voice+text' : 'text') {
  const layout = computeLaneLayout(fftSizeFor(cover.length), SAMPLE_RATE)
  return frameBits(await encryptText(text, KEY), layout, content)
}

describe('text-only payload', () => {
  it('marks text 0xA6, voice + text 0xA5 and voice-only 0xA7', async () => {
    expect(bitsToBytes((await textBits('x', false)).slice(0, 8))[0]).toBe(MAGIC_TEXT_ONLY)
    expect(bitsToBytes((await textBits('x', true)).slice(0, 8))[0]).toBe(MAGIC)
    expect(bitsToBytes((await textBits('', true, 'voice')).slice(0, 8))[0]).toBe(MAGIC_VOICE_ONLY)
  })

  it('verifies the key of a voice-only file through its empty AES-GCM token', async () => {
    const enc = encode(cover, secret, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: await textBits('', true, 'voice') })
    const right = decode(enc.stages.stego, SAMPLE_RATE, { key: KEY, fftKind: 'dit' })
    expect(right.lane.content).toBe('voice')
    expect(await decryptText(right.lane.payload!, KEY)).toBe('')
    // a wrong key de-spreads with the wrong chips, so the header never syncs
    expect(decode(enc.stages.stego, SAMPLE_RATE, { key: 'wrong', fftKind: 'dit' }).lane.status).toBe('no-payload')
  })

  it('encodes without a voice, leaves the carrier band to the cover, and decodes the text', async () => {
    const bits = await textBits('only text, no voice', false)
    const enc = encode(cover, null, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: bits })
    expect(enc.hasVoice).toBe(false)
    expect(enc.gain).toBe(0)
    // nothing but the text lane changed, so the stego file is far closer to the cover than with a voice
    const withVoice = encode(cover, secret, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: await textBits('t', true) })
    expect(gainMatchedSnrDb(cover, enc.stages.stego)).toBeGreaterThan(gainMatchedSnrDb(cover, withVoice.stages.stego) + 5)

    const dec = decode(applyChannelWithStats(enc.stages.stego, CLEAN_CHANNEL).out, SAMPLE_RATE, { key: KEY, fftKind: 'dit' })
    expect(dec.lane.status).toBe('ok')
    expect(dec.lane.content).toBe('text')
    expect(await decryptText(dec.lane.payload!, KEY)).toBe('only text, no voice')
  })

  it('reports voice + text content, and null when nothing syncs', async () => {
    const enc = encode(cover, secret, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: await textBits('hi', true) })
    expect(decode(enc.stages.stego, SAMPLE_RATE, { key: KEY, fftKind: 'dit' }).lane.content).toBe('voice+text')
    expect(decode(enc.stages.stego, SAMPLE_RATE, { key: `${KEY}x`, fftKind: 'dit' }).lane.content).toBe(null)
  })

  it('refuses an empty payload', () => {
    expect(() => encode(cover, null, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit' })).toThrow(/Nothing to hide/)
  })
})

describe('encoder stage events', () => {
  it('reports every block once, in execution order, each started before it finishes', async () => {
    const events: StageEvent[] = []
    encode(cover, secret, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: await textBits('hi', true) }, (e) => events.push(e))
    const finished = events.filter((e) => e.status !== 'running').map((e) => e.stage)
    const expected = ENCODE_RUN_STAGES.filter((s) => s !== 'aes' && s !== 'analysis')
    expect(finished).toEqual(expected)
    for (const e of events.filter((e) => e.status === 'done')) {
      expect(e.ms).toBeGreaterThanOrEqual(0)
      expect(events.indexOf(e)).toBeGreaterThan(events.findIndex((x) => x.stage === e.stage && x.status === 'running'))
    }
  })

  it('marks the voice blocks skipped for a text-only run, and spreading skipped for voice only', async () => {
    const textOnly: StageEvent[] = []
    encode(cover, null, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit', textBits: await textBits('hi', false) }, (e) => textOnly.push(e))
    const skipped = textOnly.filter((e) => e.status === 'skipped').map((e) => e.stage)
    expect(skipped).toEqual(['fir', 'reverse', 'invert', 'permute', 'shift'])

    const voiceOnly: StageEvent[] = []
    encode(cover, secret, SAMPLE_RATE, { key: KEY, strengthDb: -20, fftKind: 'dit' }, (e) => voiceOnly.push(e))
    expect(voiceOnly.filter((e) => e.status === 'skipped').map((e) => e.stage)).toEqual(['spread'])
  })
})

describe('frequency-domain time reversal (block-recurrence phase ramp)', () => {
  it('matches a direct time reversal to round-off', () => {
    const len = 50_000
    const x = Float32Array.from({ length: len }, (_, i) => Math.sin(i * 0.013) + 0.3 * Math.cos(i * 0.31))
    const n = 65536
    const y = inverseRealFft(reverseInFrequency(realFft(x, n), len), len)
    let err = 0
    for (let i = 0; i < len; i++) err = Math.max(err, Math.abs(y[i] - x[len - 1 - i]))
    expect(err).toBeLessThan(1e-6)
  })
})

describe('channel statistics', () => {
  it('counts samples pushed past full scale', () => {
    const x = Float32Array.of(0.5, 0.9, -0.95, 0.2)
    expect(applyChannelWithStats(x, { ...CLEAN_CHANNEL, gainDb: 6 }).clipped).toBe(2)
    expect(applyChannelWithStats(x, CLEAN_CHANNEL).clipped).toBe(0)
  })
})
