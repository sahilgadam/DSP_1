import * as d3 from 'd3'
import { useId, useMemo } from 'react'
import { useElementWidth } from './use-element-width'

export interface ChartSeries {
  x: Float32Array
  y: Float32Array
  color: string
  label: string
  dashed?: boolean
}

export interface ChartBand {
  from: number
  to: number
  color: string
  label: string
}

interface LineChartProps {
  series: ChartSeries[]
  bands?: ChartBand[]
  xDomain: [number, number]
  /** Defaults to [max - range, max + 5] over the visible data. */
  yDomain?: [number, number]
  yRange?: number
  height?: number
  xLabel?: string
  yLabel?: string
  xFormat?: (v: number) => string
  /** Soft gradient under each solid trace — the spectrum-analyser look. */
  fill?: boolean
  xTicks?: number
  yTicks?: number
  strokeWidth?: number
}

const M = { top: 12, right: 12, bottom: 30, left: 44 }

/** Max-pools a series into ~one point per pixel so 100k-point spectra stay cheap to draw. */
function pool(x: Float32Array, y: Float32Array, domain: [number, number], buckets: number): [number, number][] {
  const out: [number, number][] = []
  const [x0, x1] = domain
  const span = x1 - x0
  let cur = -1
  let best = -Infinity
  let bestX = 0
  for (let i = 0; i < x.length; i++) {
    if (x[i] < x0 || x[i] > x1) continue
    const b = Math.min(buckets - 1, Math.floor(((x[i] - x0) / span) * buckets))
    if (b !== cur) {
      if (cur >= 0) out.push([bestX, best])
      cur = b
      best = -Infinity
    }
    if (y[i] > best) {
      best = y[i]
      bestX = x[i]
    }
  }
  if (cur >= 0) out.push([bestX, best])
  return out
}

export function LineChart({
  series,
  bands = [],
  xDomain,
  yDomain,
  yRange = 90,
  height = 220,
  xLabel = 'Frequency (kHz)',
  yLabel = 'dB',
  xFormat = (v) => (v / 1000).toFixed(0),
  fill = false,
  xTicks = 8,
  yTicks = 5,
  strokeWidth = 1.4,
}: LineChartProps) {
  const gradientId = useId()
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const innerW = Math.max(50, width - M.left - M.right)
  const innerH = height - M.top - M.bottom

  const pooled = useMemo(
    () => series.map((s) => pool(s.x, s.y, xDomain, Math.max(50, Math.floor(innerW)))),
    [series, xDomain, innerW],
  )

  const yDom = useMemo<[number, number]>(() => {
    if (yDomain) return yDomain
    let max = -Infinity
    pooled.forEach((pts) => pts.forEach(([, v]) => (max = Math.max(max, v))))
    if (!Number.isFinite(max)) max = 0
    return [max - yRange, max + 5]
  }, [pooled, yDomain, yRange])

  const xs = d3.scaleLinear().domain(xDomain).range([0, innerW])
  const ys = d3.scaleLinear().domain(yDom).range([innerH, 0]).clamp(true)
  const line = d3
    .line<[number, number]>()
    .x((d) => xs(d[0]))
    .y((d) => ys(d[1]))
  const area = d3
    .area<[number, number]>()
    .x((d) => xs(d[0]))
    .y0(innerH)
    .y1((d) => ys(d[1]))

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} className="overflow-visible">
        {fill && (
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.label} id={`${gradientId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
        )}
        <g transform={`translate(${M.left},${M.top})`}>
          {ys.ticks(yTicks).map((t) => (
            <g key={`y${t}`}>
              <line x1={0} x2={innerW} y1={ys(t)} y2={ys(t)} stroke="rgba(148,163,184,0.12)" />
              <text x={-8} y={ys(t)} dy="0.32em" textAnchor="end" className="fill-slate-500 font-mono text-[10px]">
                {t}
              </text>
            </g>
          ))}
          {xs.ticks(xTicks).map((t) => (
            <g key={`x${t}`}>
              <line x1={xs(t)} x2={xs(t)} y1={0} y2={innerH} stroke="rgba(148,163,184,0.08)" />
              <text x={xs(t)} y={innerH + 16} textAnchor="middle" className="fill-slate-500 font-mono text-[10px]">
                {xFormat(t)}
              </text>
            </g>
          ))}
          {bands.map((b) => (
            <g key={b.label}>
              <rect
                x={xs(Math.max(b.from, xDomain[0]))}
                width={Math.max(0, xs(Math.min(b.to, xDomain[1])) - xs(Math.max(b.from, xDomain[0])))}
                y={0}
                height={innerH}
                fill={b.color}
                opacity={0.12}
              />
              <text x={xs(Math.max(b.from, xDomain[0])) + 4} y={12} className="text-[10px] font-semibold" fill={b.color}>
                {b.label}
              </text>
            </g>
          ))}
          {fill &&
            pooled.map((pts, i) =>
              series[i].dashed ? null : <path key={`fill-${series[i].label}`} d={area(pts) ?? ''} fill={`url(#${gradientId}-${i})`} stroke="none" />,
            )}
          {pooled.map((pts, i) => (
            <path
              key={series[i].label}
              d={line(pts) ?? ''}
              fill="none"
              stroke={series[i].color}
              strokeWidth={strokeWidth}
              strokeDasharray={series[i].dashed ? '4 3' : undefined}
              strokeLinejoin="round"
              opacity={0.95}
            />
          ))}
          <text x={innerW / 2} y={innerH + 28} textAnchor="middle" className="fill-slate-500 text-[10px]">
            {xLabel}
          </text>
          <text transform={`translate(-34,${innerH / 2}) rotate(-90)`} textAnchor="middle" className="fill-slate-500 text-[10px]">
            {yLabel}
          </text>
        </g>
      </svg>
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-4 pl-11 text-[11px] text-slate-400">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
