import { describe, expect, it } from 'vitest'
import type { AudioClip } from '../audio/load-audio'
import { SAMPLE_RATE } from '../dsp/constants'
import { encryptText, utf8Length } from '../dsp/crypto'
import { computeLaneLayout, frameBits } from '../dsp/bit-lane'
import { fftSizeFor } from '../dsp/stego'
import { capacityInfo, channelLabel, coverTextLimit, formatBytes, formatHz, isSilent, validateSender } from './sender-validation'

function clip(seconds: number, { silent = false, name = 'clip.wav' } = {}): AudioClip {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  if (!silent) for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.5
  return { name, samples, duration: samples.length / SAMPLE_RATE, truncated: false }
}

const base = { cover: clip(8), secret: clip(3), key: 'dsp-cie-2026', hiddenText: '', beginner: false }
const ids = (input: Parameters<typeof validateSender>[0]) => validateSender(input).issues.map((i) => i.id)

describe('capacity', () => {
  it('counts UTF-8 bytes, not characters', () => {
    const info = capacityInfo(clip(8), 'héllo 🎧')
    expect(info.characters).toBe(7) // h é l l o ␣ 🎧
    expect(info.used).toBe(utf8Length('héllo 🎧'))
    expect(info.used).toBe(11) // é = 2 bytes, 🎧 = 4, the rest 1 each
  })

  it('matches the budget the encoder actually enforces', async () => {
    const cover = clip(11.5)
    const limit = coverTextLimit(cover).limit!
    const layout = computeLaneLayout(fftSizeFor(cover.samples.length), SAMPLE_RATE)
    // A plaintext of exactly `limit` bytes must still frame; one byte more must not.
    const fits = await encryptText('x'.repeat(limit), 'key')
    expect(() => frameBits(fits, layout)).not.toThrow()
    const spills = await encryptText('x'.repeat(limit + 1), 'key')
    expect(() => frameBits(spills, layout)).toThrow()
  })

  it('reports no capacity for a cover that is too short for the lane', () => {
    const { limit, error } = coverTextLimit(clip(0.2))
    expect(limit).toBe(0)
    expect(error).toMatch(/too short/i)
  })

  it('has no limit and no error before a cover is loaded', () => {
    const info = capacityInfo(null, 'anything')
    expect(info.limit).toBeNull()
    expect(info.over).toBe(false)
    expect(info.error).toBeNull()
  })

  it('flags text that overflows the cover', () => {
    const cover = clip(8)
    const limit = coverTextLimit(cover).limit!
    expect(capacityInfo(cover, 'x'.repeat(limit)).over).toBe(false)
    expect(capacityInfo(cover, 'x'.repeat(limit + 1)).over).toBe(true)
    expect(capacityInfo(cover, 'x'.repeat(limit + 1)).remaining).toBe(-1)
  })

  it('grows the budget with a longer cover', () => {
    expect(coverTextLimit(clip(23)).limit!).toBeGreaterThan(coverTextLimit(clip(6)).limit!)
  })
})

describe('validateSender', () => {
  it('passes with a cover, a secret and a key', () => {
    const status = validateSender(base)
    expect(status.ready).toBe(true)
    expect(status.blocking).toHaveLength(0)
  })

  it('blocks on a missing cover, secret or key', () => {
    expect(ids({ ...base, cover: null })).toContain('cover-missing')
    expect(ids({ ...base, secret: null })).toContain('secret-missing')
    expect(ids({ ...base, key: '' })).toContain('key-missing')
    expect(ids({ ...base, key: '   ' })).toContain('key-missing')
    expect(validateSender({ ...base, key: '   ' }).ready).toBe(false)
  })

  it('requires the secret voice in beginner mode too, since encode() does', () => {
    expect(validateSender({ ...base, secret: null, beginner: true }).ready).toBe(false)
    expect(validateSender({ ...base, secret: null, beginner: true }).blocking.map((i) => i.id)).toContain('secret-missing')
  })

  it('blocks silent audio the way the encoder does', () => {
    expect(ids({ ...base, cover: clip(8, { silent: true }) })).toContain('cover-silent')
    expect(ids({ ...base, secret: clip(3, { silent: true }) })).toContain('secret-silent')
  })

  it('blocks hidden text that will not fit', () => {
    const cover = clip(8)
    const limit = coverTextLimit(cover).limit!
    const status = validateSender({ ...base, cover, hiddenText: 'x'.repeat(limit + 20) })
    expect(status.ready).toBe(false)
    expect(status.blocking.map((i) => i.id)).toContain('text-too-long')
    expect(status.blocking[0].detail).toMatch(/20 bytes/)
  })

  it('blocks text on a cover with no lane capacity, but allows an empty box', () => {
    const tiny = clip(0.2)
    expect(ids({ ...base, cover: tiny, hiddenText: 'hi' })).toContain('text-no-capacity')
    expect(ids({ ...base, cover: tiny, hiddenText: '' })).not.toContain('text-no-capacity')
  })

  it('warns without blocking for trimming, a long secret and a weak key', () => {
    const trimmed = { ...clip(5), truncated: true }
    const status = validateSender({ ...base, cover: trimmed, secret: clip(9), key: 'ab ' })
    expect(status.ready).toBe(true)
    const warn = status.warnings.map((i) => i.id)
    expect(warn).toContain('cover-trimmed')
    expect(warn).toContain('secret-longer')
    expect(warn).toContain('key-short')
    expect(warn).toContain('key-whitespace')
  })

  it('warns when the text nearly fills the lane', () => {
    const cover = clip(8)
    const limit = coverTextLimit(cover).limit!
    const status = validateSender({ ...base, cover, hiddenText: 'x'.repeat(limit) })
    expect(status.ready).toBe(true)
    expect(status.warnings.map((i) => i.id)).toContain('text-near-limit')
  })
})

describe('formatting helpers', () => {
  it('formats sizes, rates and channels', () => {
    expect(formatBytes(640)).toBe('640 B')
    expect(formatBytes(5 * 1024)).toBe('5.0 kB')
    expect(formatBytes(900 * 1024)).toBe('900 kB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
    expect(formatHz(44100)).toBe('44.1 kHz')
    expect(formatHz(48000)).toBe('48 kHz')
    expect(channelLabel(1)).toBe('mono')
    expect(channelLabel(2)).toBe('stereo')
    expect(channelLabel(6)).toBe('6 channels')
  })

  it('caches silence per clip object', () => {
    const quiet = clip(1, { silent: true })
    expect(isSilent(quiet)).toBe(true)
    expect(isSilent(quiet)).toBe(true)
    expect(isSilent(clip(1))).toBe(false)
  })
})
