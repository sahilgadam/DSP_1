/**
 * Sender-side preflight for Step 1.
 *
 * Every blocking check mirrors a precondition the encoder itself enforces (`encode()` in dsp/stego.ts,
 * `frameBits()` in dsp/bit-lane.ts, `assertKey()`), using the same functions and constants — so the
 * Continue button is enabled exactly when the DSP chain would succeed, and the reasons it gives are
 * the reasons the encoder would have thrown.
 */
import type { AudioClip } from '../audio/load-audio'
import { peak } from '../dsp/analysis'
import { computeLaneLayout, payloadCapacityBytes } from '../dsp/bit-lane'
import { MAX_DURATION_S, SAMPLE_RATE } from '../dsp/constants'
import { CRYPTO_OVERHEAD, utf8Length } from '../dsp/crypto'
import { computeLayout } from '../dsp/spectral-ops'
import { fftSizeFor } from '../dsp/stego'

export interface CapacityInfo {
  /** Plaintext bytes this cover can carry, or null while no cover is loaded. */
  limit: number | null
  /** UTF-8 bytes the current text occupies (not characters — emoji cost 4). */
  used: number
  characters: number
  remaining: number
  over: boolean
  /** Fill ratio 0-100 for the meter. */
  pct: number
  /** Set when the cover cannot carry text at all (too short for the lane). */
  error: string | null
}

/**
 * Exact plaintext budget for a cover: the lane's payload capacity minus AES-GCM's salt, IV and tag.
 * Mirrors what `encode()` computes for the same clip length.
 */
export function coverTextLimit(cover: AudioClip | null): { limit: number | null; error: string | null } {
  if (!cover) return { limit: null, error: null }
  if (cover.samples.length === 0) return { limit: 0, error: 'The cover audio is empty.' }
  try {
    const layout = computeLaneLayout(fftSizeFor(cover.samples.length), SAMPLE_RATE)
    const limit = payloadCapacityBytes(layout) - CRYPTO_OVERHEAD
    if (limit <= 0) {
      return { limit: 0, error: `This cover (${cover.duration.toFixed(2)} s) is too short to carry any hidden text. Use a cover of about 6 s or more.` }
    }
    return { limit, error: null }
  } catch (e) {
    return { limit: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export function capacityInfo(cover: AudioClip | null, text: string): CapacityInfo {
  const { limit, error } = coverTextLimit(cover)
  const used = utf8Length(text)
  const characters = [...text].length
  return {
    limit,
    used,
    characters,
    remaining: limit === null ? 0 : limit - used,
    over: limit !== null && used > limit,
    pct: limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
    error,
  }
}

export type IssueTone = 'blocking' | 'warning'

export interface SenderIssue {
  id: string
  /** Short label for the summary chip. */
  label: string
  /** Full sentence telling the user what to do. */
  detail: string
  tone: IssueTone
}

export interface SenderInput {
  cover: AudioClip | null
  secret: AudioClip | null
  key: string
  hiddenText: string
  beginner: boolean
}

/** peak() walks every sample, so cache per clip object — clips are replaced, never mutated. */
const silenceCache = new WeakMap<AudioClip, boolean>()

export function isSilent(clip: AudioClip): boolean {
  const cached = silenceCache.get(clip)
  if (cached !== undefined) return cached
  const silent = peak(clip.samples) === 0
  silenceCache.set(clip, silent)
  return silent
}

/** True when the cover is long enough for the FFT layout the encoder will build. */
function coverLayoutError(cover: AudioClip): string | null {
  try {
    computeLayout(fftSizeFor(cover.samples.length), SAMPLE_RATE)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export interface SenderStatus {
  issues: SenderIssue[]
  blocking: SenderIssue[]
  warnings: SenderIssue[]
  ready: boolean
  capacity: CapacityInfo
}

export function validateSender({ cover, secret, key, hiddenText, beginner }: SenderInput): SenderStatus {
  const issues: SenderIssue[] = []
  const capacity = capacityInfo(cover, hiddenText)

  // --- cover ---------------------------------------------------------------
  if (!cover) {
    issues.push({
      id: 'cover-missing',
      label: 'Cover audio',
      detail: 'Load the cover audio that everyone will hear — upload a file, or use the demo clip.',
      tone: 'blocking',
    })
  } else {
    if (cover.samples.length === 0) {
      issues.push({ id: 'cover-empty', label: 'Cover audio', detail: 'The cover audio contains no samples. Load a different file.', tone: 'blocking' })
    } else if (isSilent(cover)) {
      issues.push({ id: 'cover-silent', label: 'Cover audio', detail: 'The cover audio is silent, so there is nothing to hide the secret in. Load a track with sound.', tone: 'blocking' })
    }
    const layoutError = coverLayoutError(cover)
    if (layoutError) issues.push({ id: 'cover-layout', label: 'Cover audio', detail: `${layoutError} Use a longer cover track.`, tone: 'blocking' })
    if (cover.truncated) {
      issues.push({ id: 'cover-trimmed', label: 'Cover trimmed', detail: `Only the first ${MAX_DURATION_S} s of the cover is used.`, tone: 'warning' })
    }
  }

  // --- payload: a voice, a text, or both (encode() rejects neither) --------
  const hasText = hiddenText.trim().length > 0
  if (!secret) {
    if (!hasText) {
      issues.push({
        id: 'payload-missing',
        label: 'Payload',
        detail: beginner
          ? 'Add something to hide: record or load a voice message, type a hidden text, or both.'
          : 'Nothing to hide yet: load a secret voice (record, upload or demo), type a hidden text, or both.',
        tone: 'blocking',
      })
    }
  } else {
    if (secret.samples.length === 0) {
      issues.push({ id: 'secret-empty', label: 'Voice message', detail: 'The secret voice contains no samples. Record or load it again.', tone: 'blocking' })
    } else if (isSilent(secret)) {
      issues.push({ id: 'secret-silent', label: 'Voice message', detail: 'The secret voice is silent. Record again, and check that the right microphone is selected.', tone: 'blocking' })
    }
    if (cover && secret.duration > cover.duration) {
      issues.push({
        id: 'secret-longer',
        label: 'Voice trimmed',
        detail: `The secret (${secret.duration.toFixed(1)} s) is longer than the cover (${cover.duration.toFixed(1)} s) and will be cut to fit.`,
        tone: 'warning',
      })
    }
  }
  if (hiddenText.length > 0 && !hasText) {
    issues.push({
      id: 'text-blank',
      label: 'Hidden text',
      detail: 'The hidden text contains only spaces or line breaks, so no text will be sent.',
      tone: 'warning',
    })
  }

  // --- key (assertKey: a blank key throws) ---------------------------------
  const trimmedKey = key.trim()
  if (!trimmedKey) {
    issues.push({ id: 'key-missing', label: 'Secret key', detail: 'Type a secret key. The receiver needs the same key to recover anything.', tone: 'blocking' })
  } else {
    if (trimmedKey.length < 4) {
      issues.push({ id: 'key-short', label: 'Weak key', detail: 'This key is very short. A longer passphrase is much harder to guess.', tone: 'warning' })
    }
    if (key !== trimmedKey) {
      issues.push({
        id: 'key-whitespace',
        label: 'Key spacing',
        detail: 'The key starts or ends with a space. The receiver must type it exactly, spaces included.',
        tone: 'warning',
      })
    }
  }

  // --- hidden text (frameBits rejects an oversized payload) ----------------
  if (capacity.error && hasText) {
    issues.push({ id: 'text-no-capacity', label: 'Hidden text', detail: `${capacity.error} Clear the text, or load a longer cover.`, tone: 'blocking' })
  } else if (hasText && capacity.over) {
    issues.push({
      id: 'text-too-long',
      label: 'Hidden text',
      detail: `The hidden text needs ${capacity.used} bytes but this cover carries ${capacity.limit}. Remove about ${capacity.used - (capacity.limit ?? 0)} bytes, or use a longer cover.`,
      tone: 'blocking',
    })
  } else if (hasText && capacity.limit !== null && capacity.limit > 0 && capacity.used > capacity.limit * 0.9) {
    issues.push({ id: 'text-near-limit', label: 'Hidden text', detail: `Only ${capacity.remaining} bytes left in the text lane.`, tone: 'warning' })
  }

  const blocking = issues.filter((i) => i.tone === 'blocking')
  return { issues, blocking, warnings: issues.filter((i) => i.tone === 'warning'), ready: blocking.length === 0, capacity }
}

/** "1.9 MB", "812 kB", "640 B" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** "44.1 kHz" */
export function formatHz(hz: number): string {
  return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
}

export function channelLabel(channels: number): string {
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels} channels`
}
