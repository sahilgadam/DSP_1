import { create } from 'zustand'
import type { AudioClip } from '../audio/load-audio'
import { CLEAN_CHANNEL, type ChannelParams } from '../dsp/channel'
import { DEFAULT_STRENGTH_DB, SAMPLE_RATE } from '../dsp/constants'
import type { FftKind } from '../dsp/fft'
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

  goTo: (step) => set({ step: Math.min(step, get().maxReachableStep()) as StepIndex, error: null }),
  setUIMode: (uiMode) => set({ uiMode }),
  // Changing an upstream input invalidates everything computed from it.
  setCover: (cover) => set({ cover, encoded: null, transmitted: null, decoded: null }),
  setSecret: (secret) => set({ secret, encoded: null, transmitted: null, decoded: null }),
  setKey: (key) => set({ key, encoded: null, transmitted: null, decoded: null }),
  setStrengthDb: (strengthDb) => set({ strengthDb, encoded: null, transmitted: null, decoded: null }),
  setHiddenText: (hiddenText) => set({ hiddenText, encoded: null, transmitted: null, decoded: null }),
  setChannel: (patch) => set((s) => ({ channel: { ...s.channel, ...patch }, transmitted: null, decoded: null })),
  setReceiverKey: (receiverKey) => set({ receiverKey, decoded: null }),
  setFftKind: (fftKind) => set({ fftKind, decoded: null }),
  setReceivedFile: (receivedFile) => set({ receivedFile, decoded: null }),
  setError: (error) => set({ error }),

  maxReachableStep: () => {
    const s = get()
    if (s.decoded) return 4
    if (s.transmitted || s.receivedFile) return 3
    if (s.encoded) return 2
    if (s.cover && s.secret) return 1
    return 0
  },

  encode: async () => {
    const { cover, secret, key, strengthDb, fftKind, hiddenText } = get()
    if (!cover || !secret) {
      set({ error: 'Load both a cover track and a secret voice first.' })
      return false
    }
    set({ busy: 'encode', error: null })
    try {
      const encoded = await runEncode(cover.samples, secret.samples, SAMPLE_RATE, { key, strengthDb, fftKind }, hiddenText)
      set({ encoded, transmitted: null, decoded: null, busy: null })
      return true
    } catch (e) {
      set({ busy: null, error: `Encoding failed: ${message(e)}` })
      return false
    }
  },

  transmit: async () => {
    const { encoded, channel } = get()
    if (!encoded) {
      set({ error: 'Encode first.' })
      return false
    }
    set({ busy: 'channel', error: null })
    try {
      const transmitted = await runChannel(encoded.stages.stego.samples, SAMPLE_RATE, channel)
      set({ transmitted, decoded: null, busy: null, receivedFile: null })
      return true
    } catch (e) {
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
    set({ busy: 'decode', error: null })
    try {
      const reference = encoded?.stages['secret-bandlimited'].samples ?? null
      const referenceBits = encoded?.text?.bits ?? null
      const decoded = await runDecode(received, SAMPLE_RATE, { key: receiverKey, fftKind }, reference, referenceBits)
      set({ decoded, busy: null })
      return true
    } catch (e) {
      set({ busy: null, error: `Decoding failed: ${message(e)}` })
      return false
    }
  },
}))
