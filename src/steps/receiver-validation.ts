/**
 * Preflight for the Receiver step.
 *
 * The receiver only ever has a file and a key, so these checks use nothing from the sender's state.
 * They mirror what `decode()` in dsp/stego.ts enforces, and nothing more: whether a file actually
 * carries a hidden message cannot be told from its spectrum. A real stego file has *less* energy in
 * the 16.5-19.9 kHz carrier band than an ordinary recording (the encoder band-stops the cover there
 * before adding a quiet hidden signal), and the gap between a valid file and one whose top band was
 * stripped by MP3 is only ~19 dB - well inside the range real material spans. Only the decode can
 * answer that, so the verdict below reports what it actually proved.
 */
import type { AudioClip } from '../audio/load-audio'
import { peak } from '../dsp/analysis'
import { MAX_DURATION_S, SAMPLE_RATE } from '../dsp/constants'
import { computeLayout } from '../dsp/spectral-ops'
import { fftSizeFor } from '../dsp/stego'

export interface ReceivedAudioCheck {
  /** Set when the file cannot be decoded at all — the key step stays locked. */
  error: string | null
  /** Set when the file decodes but something is worth saying before recovery. */
  warning: string | null
}

/** Everything that can honestly be judged about a received file before a key is involved. */
export function checkReceivedAudio(clip: AudioClip | null): ReceivedAudioCheck {
  if (!clip) return { error: null, warning: null }

  if (clip.samples.length === 0) {
    return { error: 'This file decoded to zero samples, so there is nothing to recover.', warning: null }
  }
  if (peak(clip.samples) === 0) {
    return { error: 'This file is completely silent. A stego file always carries its cover audio, so this is not one.', warning: null }
  }
  try {
    computeLayout(fftSizeFor(clip.samples.length), SAMPLE_RATE)
  } catch (e) {
    return { error: `${e instanceof Error ? e.message : String(e)} This clip is too short to hold the hidden band.`, warning: null }
  }
  if (clip.truncated) {
    return { error: null, warning: `Only the first ${MAX_DURATION_S} s of this file is used, so anything hidden after that is lost.` }
  }
  return { error: null, warning: null }
}

export interface KeyCheck {
  error: string | null
  warning: string | null
}

/** `decode()` rejects a blank key; spacing is legal but almost always a mistake. */
export function checkReceiverKey(key: string): KeyCheck {
  if (key.trim().length === 0) {
    return { error: 'Enter the key the sender used. Without it nothing can be unscrambled.', warning: null }
  }
  if (key !== key.trim()) {
    return { error: null, warning: 'This key starts or ends with a space. It must match the sender’s key character for character.' }
  }
  return { error: null, warning: null }
}

export type Verdict = 'ok' | 'auth-failed' | 'no-payload'

/** Plain-language reading of what the decode actually proved, with no reference to sender state. */
export function recoveryVerdict(status: Verdict): { tone: 'ok' | 'bad' | 'unsure'; title: string; detail: string } {
  if (status === 'ok') {
    return {
      tone: 'ok',
      title: 'Key verified — hidden text recovered',
      detail: 'The text lane synchronised and AES-GCM authenticated it, which proves this key matches the one used to hide the message.',
    }
  }
  if (status === 'auth-failed') {
    return {
      tone: 'bad',
      title: 'Wrong key, or the file was altered',
      detail: 'A text lane was found but its authentication tag did not verify. Check the key for typos, and make sure the file was not re-encoded after it was created.',
    }
  }
  return {
    tone: 'unsure',
    title: 'No text lane synchronised',
    detail:
      'The header never matched. If the sender included a text message, this key is wrong or this is not the stego file. If they sent voice only, that is expected — play the recovered audio below to check it.',
  }
}
