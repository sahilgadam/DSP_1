/**
 * Live speech-to-text on the microphone, built on the Web Speech API.
 *
 * The API only ever listens to the live microphone — it cannot be handed a file or an AudioBuffer —
 * so this runs alongside MicRecorder while the user records, and uploaded clips are not transcribed.
 * Recognition is strictly best-effort: every failure is reported as a message and never stops the
 * recording itself.
 */

interface SpeechAlternative {
  transcript: string
}

interface SpeechResult {
  readonly length: number
  readonly isFinal: boolean
  readonly [index: number]: SpeechAlternative
}

interface SpeechResultList {
  readonly length: number
  readonly [index: number]: SpeechResult
}

interface SpeechResultEvent {
  resultIndex: number
  results: SpeechResultList
}

interface SpeechErrorEvent {
  error: string
}

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
}

type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** True when this browser exposes the Web Speech API (Chrome, Edge, Safari; not Firefox). */
export function isTranscriptionSupported(): boolean {
  return recognitionCtor() !== null
}

export const TRANSCRIPTION_UNSUPPORTED_MESSAGE =
  'This browser cannot transcribe speech (try Chrome, Edge or Safari). Recording still works — type the hidden text yourself.'

export const TRANSCRIPTION_UPLOAD_MESSAGE =
  'Uploaded audio is not transcribed — the browser can only recognise speech while recording. Record the message, or type it on the right.'

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Speech recognition was blocked. Allow microphone access for this site to transcribe automatically.',
  'service-not-allowed': 'The browser refused to start its speech service, so nothing was transcribed.',
  'audio-capture': 'No microphone was available for speech recognition.',
  network: 'The speech service could not be reached. Your recording was kept, but there is no transcript.',
  'no-speech': 'No speech was recognised, so the hidden text was left unchanged.',
  'language-not-supported': 'This browser cannot transcribe the current language.',
  aborted: 'Speech recognition stopped before anything was recognised.',
}

export function transcriptionErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? `Speech recognition failed (${code}). Your recording was kept — type the hidden text instead.`
}

export interface TranscriberHandlers {
  /** Called as words arrive: `settled` is confirmed text, `pending` is the phrase still being revised. */
  onUpdate?: (settled: string, pending: string) => void
  onError?: (message: string) => void
}

/** Chrome ends a session after a pause; restart it while recording, with a ceiling so a failing service cannot spin. */
const MAX_RESTARTS = 50

/** Longest wait for the engine's closing results after stop() before resolving with what we have. */
const FLUSH_TIMEOUT_MS = 1500

export class SpeechTranscriber {
  private recognition: Recognition | null = null
  private settled = ''
  private pending = ''
  private listening = false
  private restarts = 0
  private endWaiters: (() => void)[] = []

  /** Starts listening. Returns false when the API is missing or refuses to start — the caller keeps recording. */
  start(handlers: TranscriberHandlers = {}): boolean {
    const Ctor = recognitionCtor()
    if (!Ctor) return false

    let recognition: Recognition
    try {
      recognition = new Ctor()
    } catch {
      return false
    }

    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    recognition.onresult = (e) => {
      let pending = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) this.settled = `${this.settled} ${text}`.trim()
        else pending = `${pending} ${text}`.trim()
      }
      this.pending = pending
      handlers.onUpdate?.(this.settled, this.pending)
    }

    recognition.onerror = (e) => {
      // `aborted` and a `no-speech` that still produced words are side effects of our own stop(): stay quiet.
      if (e.error === 'aborted' || (e.error === 'no-speech' && this.settled)) return
      handlers.onError?.(transcriptionErrorMessage(e.error))
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') this.listening = false
    }

    recognition.onend = () => {
      if (this.listening && this.restarts < MAX_RESTARTS) {
        this.restarts++
        try {
          recognition.start()
          return
        } catch {
          this.listening = false
        }
      }
      this.listening = false
      this.endWaiters.splice(0).forEach((resolve) => resolve())
    }

    try {
      recognition.start()
    } catch {
      return false
    }
    this.recognition = recognition
    this.listening = true
    return true
  }

  /** Stops listening and resolves with everything recognised (including a phrase still in flight). */
  async stop(): Promise<string> {
    const recognition = this.recognition
    this.recognition = null
    if (!recognition) return this.transcript()

    this.listening = false
    const ended = new Promise<void>((resolve) => {
      this.endWaiters.push(resolve)
      setTimeout(resolve, FLUSH_TIMEOUT_MS)
    })
    try {
      recognition.stop()
    } catch {
      return this.transcript()
    }
    await ended
    return this.transcript()
  }

  /** Drops the session without waiting for results (used when a recording is discarded). */
  abort(): void {
    const recognition = this.recognition
    this.recognition = null
    this.listening = false
    this.endWaiters.splice(0).forEach((resolve) => resolve())
    try {
      recognition?.abort()
    } catch {
      /* already closed */
    }
  }

  private transcript(): string {
    return `${this.settled} ${this.pending}`.trim()
  }
}
