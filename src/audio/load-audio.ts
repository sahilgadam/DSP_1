import { MAX_DURATION_S, SAMPLE_RATE } from '../dsp/constants'
import { encodeWav16 } from '../dsp/wav'
import { normalizePeak } from '../dsp/analysis'

export interface AudioClip {
  name: string
  samples: Float32Array
  duration: number
  /** True when the input was longer than MAX_DURATION_S and got trimmed. */
  truncated: boolean
  /** Details of the file or recording this clip was decoded from. */
  source?: ClipSourceInfo
}

export interface ClipSourceInfo {
  /** How the clip arrived. Only a live recording can be transcribed. */
  kind: 'file' | 'demo' | 'mic'
  /** Size in bytes of the encoded file or recorded blob. */
  bytes: number
  /** Container, e.g. "WAV" or "MP3". */
  format: string
  /** Channels in the source, before the mono downmix. */
  channels: number
  /** Sample rate stored in the file. Only containers we can read a header from report one. */
  sourceSampleRate: number | null
}

/** Refuse absurd inputs before handing them to the decoder, which would otherwise stall the tab. */
const MAX_FILE_BYTES = 80 * 1024 * 1024

const FORMATS: Record<string, string> = {
  'audio/wav': 'WAV',
  'audio/wave': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/vnd.wave': 'WAV',
  'audio/mpeg': 'MP3',
  'audio/mp3': 'MP3',
  'audio/ogg': 'OGG',
  'audio/webm': 'WEBM',
  'audio/flac': 'FLAC',
  'audio/x-flac': 'FLAC',
  'audio/mp4': 'M4A',
  'audio/x-m4a': 'M4A',
  'audio/aac': 'AAC',
}

/** Best-effort container name from the MIME type, falling back to the file extension. */
export function audioFormatLabel(mimeType: string, name: string): string {
  const mime = mimeType.split(';')[0].trim().toLowerCase()
  if (FORMATS[mime]) return FORMATS[mime]
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
  if (ext && ext.length <= 5) return ext
  const subtype = mime.split('/')[1]
  return subtype ? subtype.toUpperCase() : 'AUDIO'
}

/**
 * Sample rate and channels straight out of a RIFF/WAVE header.
 * decodeAudioData resamples to the context rate, so the file's own rate is only visible here.
 */
function readWavHeader(buf: ArrayBuffer): { sampleRate: number; channels: number } | null {
  if (buf.byteLength < 44) return null
  const view = new DataView(buf)
  const tag = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let offset = 12
  while (offset + 8 <= buf.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 16 <= buf.byteLength) {
      return { channels: view.getUint16(offset + 10, true), sampleRate: view.getUint32(offset + 12, true) }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

/** Decodes any browser-supported audio (wav/mp3/ogg/webm...) to mono at SAMPLE_RATE. */
export async function decodeToClip(data: ArrayBuffer, name: string, origin: { kind: ClipSourceInfo['kind']; mimeType?: string } = { kind: 'file' }): Promise<AudioClip> {
  const bytes = data.byteLength
  if (bytes === 0) throw new Error(`"${name}" is empty — it contains no audio data.`)
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`"${name}" is ${(bytes / 1024 / 1024).toFixed(0)} MB. Use a file under ${MAX_FILE_BYTES / 1024 / 1024} MB — only the first ${MAX_DURATION_S} s is used anyway.`)
  }
  const format = audioFormatLabel(origin.mimeType ?? '', name)
  const header = readWavHeader(data)
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  let buffer: AudioBuffer
  try {
    // decodeAudioData detaches the buffer, so parse any header before this point.
    buffer = await ctx.decodeAudioData(data)
  } catch {
    throw new Error(`Could not decode "${name}" (${format}). The file may be corrupt or use a codec this browser cannot read — try a WAV or MP3.`)
  }
  if (buffer.length === 0) throw new Error(`"${name}" decoded to zero samples — it contains no audio.`)
  const maxLen = Math.floor(MAX_DURATION_S * SAMPLE_RATE)
  const len = Math.min(buffer.length, maxLen)
  const mono = new Float32Array(len)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < len; i++) mono[i] += data[i] / buffer.numberOfChannels
  }
  return {
    name,
    samples: mono,
    duration: len / SAMPLE_RATE,
    truncated: buffer.length > maxLen,
    source: {
      kind: origin.kind,
      bytes,
      format,
      channels: buffer.numberOfChannels,
      sourceSampleRate: header?.sampleRate ?? null,
    },
  }
}

export async function loadClipFromFile(file: File, kind: ClipSourceInfo['kind'] = 'file'): Promise<AudioClip> {
  return decodeToClip(await file.arrayBuffer(), file.name, { kind, mimeType: file.type })
}

export async function loadClipFromUrl(url: string, name: string, kind: ClipSourceInfo['kind'] = 'demo'): Promise<AudioClip> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not fetch ${url} (${res.status})`)
  return decodeToClip(await res.arrayBuffer(), name, { kind, mimeType: res.headers.get('content-type') ?? '' })
}

export function clipToWavBlob(samples: Float32Array, normalize = false): Blob {
  const data = normalize ? normalizePeak(samples, 0.9) : samples
  return new Blob([encodeWav16(data, SAMPLE_RATE)], { type: 'audio/wav' })
}

export function downloadWav(samples: Float32Array, filename: string): void {
  const url = URL.createObjectURL(clipToWavBlob(samples))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Microphone recorder built on MediaRecorder. */
export class MicRecorder {
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone recording is not supported in this browser')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      throw new Error('Microphone permission was denied')
    }
    this.chunks = []
    this.recorder = new MediaRecorder(this.stream)
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.start()
  }

  stop(): Promise<AudioClip> {
    const rec = this.recorder
    if (!rec) return Promise.reject(new Error('Recorder is not running'))
    return new Promise((resolve, reject) => {
      rec.onstop = async () => {
        this.stream?.getTracks().forEach((t) => t.stop())
        this.stream = null
        this.recorder = null
        try {
          const blob = new Blob(this.chunks, { type: rec.mimeType })
          resolve(await decodeToClip(await blob.arrayBuffer(), 'Microphone recording', { kind: 'mic', mimeType: rec.mimeType }))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
      rec.stop()
    })
  }
}
