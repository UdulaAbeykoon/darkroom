import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
} from "react";
import type { ColorWheel } from "../types";
import { AdjustmentSlider } from "./ui";
import "./ColorGradingWheel.css";

type ColorGradingWheelProps = {
  label: string;
  value: ColorWheel;
  onBegin: () => void;
  onCommit: () => void;
  onChange: (value: ColorWheel) => void;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const normalizeHue = (hue: number) => ((hue % 360) + 360) % 360;

const SUPPORTED_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
]);

export default function ColorGradingWheel({
  label,
  value,
  onBegin,
  onCommit,
  onChange,
}: ColorGradingWheelProps) {
  const labelId = useId();
  const activePointerRef = useRef<number | null>(null);
  const interactionRef = useRef(false);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const beginInteraction = () => {
    if (interactionRef.current) return;
    interactionRef.current = true;
    onBegin();
  };

  const commitInteraction = () => {
    if (!interactionRef.current) return;
    interactionRef.current = false;
    onCommit();
  };

  useEffect(
    () => () => {
      if (interactionRef.current) {
        interactionRef.current = false;
        commitRef.current();
      }
    },
    [],
  );

  const setFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const x = event.clientX - centerX;
    const y = event.clientY - centerY;
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) / 2 - 7);
    const hue = normalizeHue((Math.atan2(y, x) * 180) / Math.PI);
    const saturation = clamp((Math.hypot(x, y) / radius) * 100, 0, 100);

    onChange({
      ...value,
      hue: Number(hue.toFixed(1)),
      saturation: Number(saturation.toFixed(1)),
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    activePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    beginInteraction();
    setFromPointer(event);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    setFromPointer(event);
  };

  const finishPointerInteraction = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    commitInteraction();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!SUPPORTED_KEYS.has(event.key)) return;
    event.preventDefault();
    beginInteraction();

    if (event.key === "Home") {
      onChange({ ...value, hue: 0, saturation: 0 });
      return;
    }

    const amount = event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      onChange({
        ...value,
        hue: normalizeHue(value.hue + (event.key === "ArrowRight" ? amount : -amount)),
      });
      return;
    }

    onChange({
      ...value,
      saturation: clamp(
        value.saturation + (event.key === "ArrowUp" ? amount : -amount),
        0,
        100,
      ),
    });
  };

  const hueRadians = (normalizeHue(value.hue) * Math.PI) / 180;
  const puckRadius = clamp(value.saturation, 0, 100) * 0.43;
  const wheelStyle = {
    "--color-wheel-hue": `${normalizeHue(value.hue)}deg`,
    "--color-wheel-puck-x": `${50 + Math.cos(hueRadians) * puckRadius}%`,
    "--color-wheel-puck-y": `${50 + Math.sin(hueRadians) * puckRadius}%`,
  } as CSSProperties;

  return (
    <section
      className="color-grading-wheel"
      role="group"
      aria-labelledby={labelId}
    >
      <div className="color-grading-wheel__heading">
        <strong id={labelId}>{label}</strong>
        <output aria-label={`${label} color values`}>
          H {Math.round(normalizeHue(value.hue))}°&nbsp;&nbsp;S {Math.round(value.saturation)}
        </output>
      </div>

      <div
        className="color-grading-wheel__disc"
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue and saturation`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamp(value.saturation, 0, 100))}
        aria-valuetext={`Hue ${Math.round(normalizeHue(value.hue))} degrees, saturation ${Math.round(clamp(value.saturation, 0, 100))} percent`}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
        title="Drag to set hue and saturation. Use arrow keys; press Home to reset."
        style={wheelStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerInteraction}
        onPointerCancel={finishPointerInteraction}
        onLostPointerCapture={finishPointerInteraction}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (SUPPORTED_KEYS.has(event.key)) commitInteraction();
        }}
        onBlur={commitInteraction}
      >
        <span className="color-grading-wheel__axis" aria-hidden="true" />
        <span className="color-grading-wheel__puck" aria-hidden="true" />
      </div>

      <div className="color-grading-wheel__luminance">
        <AdjustmentSlider
          label="Luminance"
          value={value.luminance}
          min={-100}
          max={100}
          defaultValue={0}
          onBegin={onBegin}
          onCommit={onCommit}
          onChange={(luminance) => onChange({ ...value, luminance })}
        />
      </div>
    </section>
  );
}

export type { ColorGradingWheelProps };
