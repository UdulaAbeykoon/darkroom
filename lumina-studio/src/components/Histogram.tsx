import { memo, useMemo } from "react";
import type { HistogramData } from "../types";

const WIDTH = 256;
const HEIGHT = 76;

function buildArea(values: number[]) {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * WIDTH;
    const normalized = Math.log1p(value) / Math.log1p(max);
    const y = HEIGHT - normalized * (HEIGHT - 3);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `M0,${HEIGHT} L${points.join(" L")} L${WIDTH},${HEIGHT} Z`;
}

function Histogram({
  data,
  clipping = false,
}: {
  data: HistogramData | null;
  clipping?: boolean;
}) {
  const paths = useMemo(
    () =>
      data
        ? {
            red: buildArea(data.red),
            green: buildArea(data.green),
            blue: buildArea(data.blue),
            luminance: buildArea(data.luminance),
          }
        : null,
    [data],
  );

  return (
    <div className="histogram" aria-label="Image histogram">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="hist-grid-fade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,.12)" />
            <stop offset="1" stopColor="rgba(255,255,255,.015)" />
          </linearGradient>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#hist-grid-fade)" />
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={WIDTH * fraction}
            x2={WIDTH * fraction}
            y1={0}
            y2={HEIGHT}
            className="histogram__grid"
          />
        ))}
        {paths ? (
          <g className="histogram__channels">
            <path d={paths.luminance} className="histogram__luma" />
            <path d={paths.red} className="histogram__red" />
            <path d={paths.green} className="histogram__green" />
            <path d={paths.blue} className="histogram__blue" />
          </g>
        ) : (
          <path
            d="M0,76 L20,70 L44,61 L64,42 L82,50 L102,24 L124,37 L145,11 L164,30 L184,41 L202,26 L224,57 L256,70 L256,76 Z"
            className="histogram__placeholder"
          />
        )}
        {clipping ? (
          <>
            <polygon points="0,0 14,0 0,14" className="histogram__shadow-clip" />
            <polygon
              points={`${WIDTH},0 ${WIDTH - 14},0 ${WIDTH},14`}
              className="histogram__highlight-clip"
            />
          </>
        ) : null}
      </svg>
      <div className="histogram__scale" aria-hidden="true">
        <span>0</span>
        <span>64</span>
        <span>128</span>
        <span>192</span>
        <span>255</span>
      </div>
    </div>
  );
}

export default memo(Histogram);
