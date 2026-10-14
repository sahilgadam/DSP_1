import { Download, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { clipToWavBlob, downloadWav } from '../../audio/load-audio'
import { cn } from '../ui/primitives'

interface WaveformPlayerProps {
  samples: Float32Array
  label?: string
  /** Normalise loudness for listening (does not change the underlying data). */
  normalize?: boolean
  color?: 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' | 'slate'
  height?: number
  downloadName?: string
  compact?: boolean
}

const COLORS = {
  cyan: ['#155e75', '#22d3ee'],
  violet: ['#4c1d95', '#a78bfa'],
  emerald: ['#065f46', '#34d399'],
  amber: ['#78350f', '#fbbf24'],
  rose: ['#881337', '#fb7185'],
  slate: ['#334155', '#cbd5e1'],
} as const

/** Only one player sounds at a time across the whole app. */
let activePlayer: WaveSurfer | null = null

export function WaveformPlayer({ samples, label, normalize, color = 'cyan', height = 64, downloadName, compact }: WaveformPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [time, setTime] = useState(0)
  const duration = samples.length / 44100

  useEffect(() => {
    if (!containerRef.current) return
    const url = URL.createObjectURL(clipToWavBlob(samples, normalize))
    const [wave, progress] = COLORS[color]
    const ws = WaveSurfer.create({
      container: containerRef.current,
      height,
      waveColor: wave,
      progressColor: progress,
      cursorColor: '#f8fafc',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
    })
    wsRef.current = ws
    setReady(false)
    setPlaying(false)
    ws.on('ready', () => setReady(true))
    ws.on('play', () => {
      if (activePlayer && activePlayer !== ws) activePlayer.pause()
      activePlayer = ws
      setPlaying(true)
    })
    ws.on('pause', () => setPlaying(false))
    ws.on('finish', () => setPlaying(false))
    ws.on('timeupdate', (t) => setTime(t))
    ws.load(url).catch(() => {
      /* superseded or destroyed before load finished */
    })
    return () => {
      if (activePlayer === ws) activePlayer = null
      ws.destroy()
      wsRef.current = null
      URL.revokeObjectURL(url)
    }
  }, [samples, normalize, color, height])

  const toggle = () => {
    wsRef.current?.playPause().catch(() => setPlaying(false))
  }

  return (
    <div className={cn('rounded-xl bg-black/30 ring-1 ring-white/10', compact ? 'p-2' : 'p-3')}>
      {label && (
        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
          <span className="truncate font-medium text-slate-200">{label}</span>
          <span className="shrink-0 font-mono text-slate-500">
            {time.toFixed(1)} / {duration.toFixed(1)} s
          </span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={!ready}
          aria-label={playing ? 'Pause' : 'Play'}
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-full text-ink-950 transition disabled:opacity-40',
            playing ? 'bg-white' : 'bg-cyan-400 hover:bg-cyan-300',
          )}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
        </button>
        <div ref={containerRef} className="min-w-0 grow" />
        {downloadName && (
          <button
            onClick={() => downloadWav(samples, downloadName)}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-400 ring-1 ring-white/10 transition hover:text-white"
            aria-label="Download WAV"
            title="Download WAV"
          >
            <Download className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
