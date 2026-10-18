import { create } from 'zustand'
import type { AudioClip } from '../audio/load-audio'
import { CLEAN_CHANNEL, type ChannelParams } from '../dsp/channel'
import { DEFAULT_STRENGTH_DB, SAMPLE_RATE } from '../dsp/constants'
import type { FftKind } from '../dsp/fft'
import type { EncodeRunStage, StageEvent } from '../dsp/stego'
import { runChannel, runDecode, runEncode } from '../worker/dsp-client'
import type { ChannelOutput, DecodeOutput, EncodeOutput } from '../worker/protocol'

export const STEPS = ['Sender', 'Encode', 'Channel', 'Receiver', 'Output'] as const
export type StepIndex = 0 | 1 | 2 | 3 | 4
export type UIMode = 'beginner' | 'dsp'

type Busy = null | 'encode' | 'channel' | 'decode'

interface StegoState {
  step: StepIndex
  uiMode: UIMode
  cover: AudioClip | null
  secret: AudioClip | null
  key: string
  strengthDb: number
  /** Optional text hidden in the encrypted bit lane. */
  hiddenText: string
  channel: ChannelParams
  receiverKey: string
  fftKind: FftKind
  /** A WAV the receiver loaded from disk instead of using the simulated channel. */
  receivedFile: AudioClip | null
  encoded: EncodeOutput | null
  transmitted: ChannelOutput | null
  decoded: DecodeOutput | null
  busy: Busy
  error: string | null
  /** Latest event of every encoder block in the current (or last) run, streamed from the worker. */
  encodeProgress: Partial<Record<EncodeRunStage, StageEvent>>
  /** Why the last encode failed, shown on the Encode step. */
  encodeError: string | null

  goTo: (step: StepIndex) => void
  setUIMode: (mode: UIMode) => void
  setCover: (clip: AudioClip | null) => void
  setSecret: (clip: AudioClip | null) => void
  setKey: (key: string) => void
  setStrengthDb: (db: number) => void
  setHiddenText: (text: string) => void
  setChannel: (patch: Partial<ChannelParams>) => void
  setReceiverKey: (key: string) => void
  setFftKind: (kind: FftKind) => void
  setReceivedFile: (clip: AudioClip | null) => void
  setError: (error: string | null) => void
  encode: () => Promise<boolean>
  transmit: () => Promise<boolean>
  decode: () => Promise<boolean>
  maxReachableStep: () => StepIndex
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Run counters: a result is applied only if no newer run started and no input it depends on changed
 * while it was computing, so a slow worker reply can never overwrite fresher state.
 */
let encodeVersion = 0
let channelVersion = 0
let decodeVersion = 0

function invalidateSender<T extends object>(patch: T) {
  encodeVersion++
  channelVersion++
  decodeVersion++
  const s = useStegoStore.getState()
  return { ...patch, encoded: null, transmitted: null, decoded: null, encodeProgress: {}, encodeError: null, busy: s.busy === 'encode' || s.busy === 'channel' || s.busy === 'decode' ? null : s.busy }
}

function invalidateReceiver<T extends object>(patch: T) {
  decodeVersion++
  const s = useStegoStore.getState()
  return { ...patch, decoded: null, busy: s.busy === 'decode' ? null : s.busy }
}

export const useStegoStore = create<StegoState>((set, get) => ({
  step: 0,
  uiMode: 'beginner',
  cover: null,
  secret: null,
  key: 'dsp-cie-2026',
  strengthDb: DEFAULT_STRENGTH_DB,
  hiddenText: 'Meet the DSP team at lab 4 at 5 PM. Bring the FFT notes!',
  channel: CLEAN_CHANNEL,
  // The receiver starts with nothing: the key must be typed in on the Receiver step.
  receiverKey: '',
  fftKind: 'dit',
  receivedFile: null,
  encoded: null,
  transmitted: null,
  decoded: null,
  busy: null,
  error: null,
  encodeProgress: {},
  encodeError: null,

  goTo: (step) => set({ step: Math.min(step, get().maxReachableStep()) as StepIndex, error: null }),
  setUIMode: (uiMode) => set({ uiMode }),
  // Changing an upstream input invalidates everything computed from it — including a run still in flight.
  setCover: (cover) => set(invalidateSender({ cover })),
  setSecret: (secret) => set(invalidateSender({ secret })),
  setKey: (key) => set(invalidateSender({ key })),
  setStrengthDb: (strengthDb) => set(invalidateSender({ strengthDb })),
  setHiddenText: (hiddenText) => set(invalidateSender({ hiddenText })),
  setChannel: (patch) =>
    set((s) => {
      channelVersion++
      return { channel: { ...s.channel, ...patch }, transmitted: null, decoded: null, busy: s.busy === 'channel' ? null : s.busy }
    }),
  setReceiverKey: (receiverKey) => set(invalidateReceiver({ receiverKey })),
  setFftKind: (fftKind) => set(invalidateReceiver({ fftKind })),
  setReceivedFile: (receivedFile) => set(invalidateReceiver({ receivedFile })),
  setError: (error) => set({ error }),

  maxReachableStep: () => {
    const s = get()
    if (s.decoded) return 4
    if (s.transmitted || s.receivedFile) return 3
    if (s.encoded) return 2
    if (s.cover && (s.secret || s.hiddenText.trim())) return 1
    return 0
  },

  encode: async () => {
    const { cover, secret, key, strengthDb, fftKind, hiddenText } = get()
    if (!cover || (!secret && !hiddenText.trim())) {
      set({ error: 'Load a cover track and add a secret voice, a hidden text, or both.' })
      return false
    }
    const version = ++encodeVersion
    set({ busy: 'encode', error: null, encodeError: null, encodeProgress: {}, encoded: null, transmitted: null, decoded: null })
    const onStage = (e: StageEvent) => {
      if (version === encodeVersion) set((s) => ({ encodeProgress: { ...s.encodeProgress, [e.stage]: e } }))
    }
    try {
      const encoded = await runEncode(cover.samples, secret?.samples ?? null, SAMPLE_RATE, { key, strengthDb, fftKind }, hiddenText, onStage)
      if (version !== encodeVersion) return false
      set({ encoded, transmitted: null, decoded: null, busy: null })
      return true
    } catch (e) {
      if (version !== encodeVersion) return false
      set({ busy: null, encodeError: message(e) })
      return false
    }
  },

  transmit: async () => {
    const { encoded, channel } = get()
    if (!encoded) {
      set({ error: 'Encode first.' })
      return false
    }
    const version = ++channelVersion
    set({ busy: 'channel', error: null })
    try {
      // a fresh noise realisation for every transmission, so "Send again" really is a new trial
      const seed = Math.floor(Math.random() * 2 ** 31)
      const transmitted = await runChannel(encoded.stages.stego.samples, SAMPLE_RATE, { ...channel, seed })
      if (version !== channelVersion) return false
      set({ transmitted, decoded: null, busy: null, receivedFile: null })
      return true
    } catch (e) {
      if (version !== channelVersion) return false
      set({ busy: null, error: `Transmission failed: ${message(e)}` })
      return false
    }
  },

  decode: async () => {
    const { transmitted, receivedFile, receiverKey, fftKind, encoded } = get()
    const received = receivedFile?.samples ?? transmitted?.received.samples
    if (!received) {
      set({ error: 'Nothing has been received yet.' })
      return false
    }
    const version = ++decodeVersion
    set({ busy: 'decode', error: null })
    try {
      // The sender's originals are only a valid yardstick for a file made from this session's encode
      // (same length); for any other file, quality metrics and BER would compare unrelated signals.
      const sameRun = !!encoded && encoded.stages.stego.samples.length === received.length
      const reference = sameRun && encoded.hasVoice ? encoded.stages['secret-bandlimited'].samples : null
      const referenceBits = sameRun ? (encoded.text?.bits ?? null) : null
      const decoded = await runDecode(received, SAMPLE_RATE, { key: receiverKey, fftKind }, reference, referenceBits)
      if (version !== decodeVersion) return false
      set({ decoded, busy: null })
      return true
    } catch (e) {
      if (version !== decodeVersion) return false
      set({ busy: null, error: `Decoding failed: ${message(e)}` })
      return false
    }
  },
}))
