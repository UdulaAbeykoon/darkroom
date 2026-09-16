import { useEffect, useMemo, useRef, useState } from "react";
import type { ToneCurvePoint } from "../types";

const WIDTH = 256;
const HEIGHT = 144;
const PADDING = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toSvg(point: ToneCurvePoint) {
  return {
    x: PADDING + point.x * (WIDTH - PADDING * 2),
    y: HEIGHT - PADDING - point.y * (HEIGHT - PADDING * 2),
  };
}

export default function CurveEditor({
  points,
  onBegin,
  onChange,
  onCommit,
}: {
  points: ToneCurvePoint[];
  onBegin: () => void;
  onChange: (points: ToneCurvePoint[]) => void;
  onCommit: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const draggingRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const sorted = useMemo(() => [...points].sort((a, b) => a.x - b.x), [points]);
  const path = sorted
    .map((point, index) => {
      const svgPoint = toSvg(point);
      return `${index ? "L" : "M"}${svgPoint.x},${svgPoint.y}`;
    })
    .join(" ");

  const pointerToPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: clamp(((clientX - rect.left) / rect.width * WIDTH - PADDING) / (WIDTH - PADDING * 2), 0, 1),
      y: clamp(1 - ((clientY - rect.top) / rect.height * HEIGHT - PADDING) / (HEIGHT - PADDING * 2), 0, 1),
    };
  };

  const finishDragging = (event?: React.PointerEvent<SVGSVGElement>) => {
    if (draggingRef.current === null) return;
    if (
      event &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = null;
    setDragging(null);
    onCommit();
  };

  useEffect(
    () => () => {
      if (draggingRef.current !== null) {
        draggingRef.current = null;
        commitRef.current();
      }
    },
    [],
  );

  return (
    <div className="curve-editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        onPointerMove={(event) => {
          if (dragging === null) return;
          const next = pointerToPoint(event.clientX, event.clientY);
          const leftBound = dragging === 0 ? 0 : sorted[dragging - 1].x + 0.015;
          const rightBound =
            dragging === sorted.length - 1 ? 1 : sorted[dragging + 1].x - 0.015;
          const updated = sorted.map((point, index) =>
            index === dragging
              ? {
                  x:
                    dragging === 0 || dragging === sorted.length - 1
                      ? point.x
                      : clamp(next.x, leftBound, rightBound),
                  y: next.y,
                }
              : point,
          );
          onChange(updated);
        }}
        onPointerUp={finishDragging}
        onPointerCancel={finishDragging}
        onLostPointerCapture={finishDragging}
        onDoubleClick={(event) => {
          const target = event.target as SVGElement;
          if (target.dataset.pointIndex) return;
          onBegin();
          onChange([
            { x: 0, y: 0 },
            { x: 0.25, y: 0.25 },
            { x: 0.5, y: 0.5 },
            { x: 0.75, y: 0.75 },
            { x: 1, y: 1 },
          ]);
          onCommit();
        }}
        onClick={(event) => {
          if ((event.target as SVGElement).dataset.pointIndex) return;
          const next = pointerToPoint(event.clientX, event.clientY);
          const distance = sorted.reduce(
            (closest, point) => Math.min(closest, Math.hypot(point.x - next.x, point.y - next.y)),
            Number.POSITIVE_INFINITY,
          );
          if (distance < 0.04 || sorted.length >= 16) return;
          onBegin();
          onChange([...sorted, next].sort((a, b) => a.x - b.x));
          onCommit();
        }}
        aria-label="Tone curve editor"
      >
        <rect x="0" y="0" width={WIDTH} height={HEIGHT} className="curve-editor__surface" />
        {[0.25, 0.5, 0.75].map((fraction) => (
          <g key={fraction}>
            <line
              x1={PADDING + fraction * (WIDTH - PADDING * 2)}
              x2={PADDING + fraction * (WIDTH - PADDING * 2)}
              y1={PADDING}
              y2={HEIGHT - PADDING}
              className="curve-editor__grid"
            />
            <line
              x1={PADDING}
              x2={WIDTH - PADDING}
              y1={PADDING + fraction * (HEIGHT - PADDING * 2)}
              y2={PADDING + fraction * (HEIGHT - PADDING * 2)}
              className="curve-editor__grid"
            />
          </g>
        ))}
        <line
          x1={PADDING}
          y1={HEIGHT - PADDING}
          x2={WIDTH - PADDING}
          y2={PADDING}
          className="curve-editor__diagonal"
        />
        <path d={path} className="curve-editor__line" />
        {sorted.map((point, index) => {
          const svgPoint = toSvg(point);
          return (
            <circle
              key={`${index}-${point.x}`}
              data-point-index={index}
              cx={svgPoint.x}
              cy={svgPoint.y}
              r={index === dragging ? 5 : 4}
              className="curve-editor__point"
              role="slider"
              tabIndex={0}
              aria-label={`Tone curve point ${index + 1}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(point.y * 100)}
              onPointerDown={(event) => {
                event.stopPropagation();
                onBegin();
                draggingRef.current = index;
                setDragging(index);
                svgRef.current?.setPointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                const delta = event.shiftKey ? 0.05 : 0.01;
                let nextX = point.x;
                let nextY = point.y;
                if (event.key === "ArrowUp") nextY += delta;
                else if (event.key === "ArrowDown") nextY -= delta;
                else if (
                  event.key === "ArrowLeft" &&
                  index > 0 &&
                  index < sorted.length - 1
                ) nextX -= delta;
                else if (
                  event.key === "ArrowRight" &&
                  index > 0 &&
                  index < sorted.length - 1
                ) nextX += delta;
                else if (event.key === "Home") nextY = 0;
                else if (event.key === "End") nextY = 1;
                else return;
                event.preventDefault();
                onBegin();
                const leftBound = index === 0 ? 0 : sorted[index - 1].x + 0.015;
                const rightBound =
                  index === sorted.length - 1 ? 1 : sorted[index + 1].x - 0.015;
                onChange(
                  sorted.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? {
                          x:
                            index === 0 || index === sorted.length - 1
                              ? candidate.x
                              : clamp(nextX, leftBound, rightBound),
                          y: clamp(nextY, 0, 1),
                        }
                      : candidate,
                  ),
                );
                onCommit();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (index === 0 || index === sorted.length - 1) return;
                onBegin();
                onChange(sorted.filter((_, pointIndex) => pointIndex !== index));
                onCommit();
              }}
            />
          );
        })}
      </svg>
      <div className="curve-editor__labels">
        <span>Shadows</span>
        <span>Midtones</span>
        <span>Highlights</span>
      </div>
    </div>
  );
}
