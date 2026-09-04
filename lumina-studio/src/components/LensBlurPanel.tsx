import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
} from "react";
import type { LensBlurAdjustments } from "../types";
import { AdjustmentSlider, Panel } from "./ui";
import "./LensBlurPanel.css";

export type LensBlurPanelProps = {
  value: LensBlurAdjustments;
  onBegin: () => void;
  onCommit: () => void;
  onChange: (value: LensBlurAdjustments) => void;
};

const BOKEH_OPTIONS: {
  value: LensBlurAdjustments["bokeh"];
  label: string;
}[] = [
  { value: "circle", label: "Circle" },
  { value: "bubble", label: "Bubble" },
  { value: "five-blade", label: "5-blade" },
  { value: "ring", label: "Ring" },
  { value: "cat-eye", label: "Cat eye" },
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function LensBlurPanel({
  value,
  onBegin,
  onCommit,
  onChange,
}: LensBlurPanelProps) {
  const refineHintId = useId();
  const focusInteractionRef = useRef(false);
  const activePointerRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(
    () => () => {
      if (focusInteractionRef.current) {
        focusInteractionRef.current = false;
        commitRef.current();
      }
    },
    [],
  );

  const commitPatch = (patch: Partial<LensBlurAdjustments>) => {
    const changed = Object.entries(patch).some(
      ([key, next]) => value[key as keyof LensBlurAdjustments] !== next,
    );
    if (!changed) return;
    onBegin();
    onChange({ ...value, ...patch });
    onCommit();
  };

  const beginFocusInteraction = () => {
    if (focusInteractionRef.current) return;
    focusInteractionRef.current = true;
    onBegin();
  };

  const commitFocusInteraction = () => {
    if (!focusInteractionRef.current) return;
    focusInteractionRef.current = false;
    activePointerRef.current = null;
    onCommit();
  };

  const updateFocus = (focusX: number, focusY: number) => {
    onChange({
      ...value,
      focusX: clamp(focusX, 0, 1),
      focusY: clamp(focusY, 0, 1),
    });
  };

  const updateFocusFromPointer = (
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    updateFocus(
      (event.clientX - bounds.left) / bounds.width,
      (event.clientY - bounds.top) / bounds.height,
    );
  };

  const handleFocusKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];

    if (event.key === "Home") {
      event.preventDefault();
      beginFocusInteraction();
      updateFocus(0.5, 0.5);
      return;
    }

    if (!direction) return;
    event.preventDefault();
    beginFocusInteraction();
    const increment = event.shiftKey ? 0.1 : 0.025;
    updateFocus(
      value.focusX + direction[0] * increment,
      value.focusY + direction[1] * increment,
    );
  };

  const selectAdjacentBokeh = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      return;
    }

    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = BOKEH_OPTIONS.length - 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + BOKEH_OPTIONS.length) % BOKEH_OPTIONS.length;
    } else {
      nextIndex = (currentIndex + 1) % BOKEH_OPTIONS.length;
    }

    const next = BOKEH_OPTIONS[nextIndex];
    if (!next) return;
    commitPatch({ bokeh: next.value });
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]',
    );
    buttons?.[nextIndex]?.focus();
  };

  const focusRangeWidth = clamp(value.focusRange, 0, 100) * 0.62;
  const focusRangeLeft = clamp(
    value.focusX * 100 - focusRangeWidth / 2,
    0,
    100 - focusRangeWidth,
  );
  const focusStyle = {
    "--lens-focus-x": `${clamp(value.focusX, 0, 1) * 100}%`,
    "--lens-focus-y": `${clamp(value.focusY, 0, 1) * 100}%`,
    "--lens-focus-range-left": `${focusRangeLeft}%`,
    "--lens-focus-range-width": `${focusRangeWidth}%`,
  } as CSSProperties;

  const applyToggle = (
    <button
      type="button"
      role="switch"
      aria-checked={value.enabled}
      aria-label="Apply Lens Blur"
      className="lens-blur-apply"
      title={value.enabled ? "Disable Lens Blur" : "Enable Lens Blur"}
      onClick={() => commitPatch({ enabled: !value.enabled })}
    >
      <span className="lens-blur-apply__checkbox" aria-hidden="true" />
      <span>Apply</span>
    </button>
  );

  return (
    <Panel title="Lens Blur" action={applyToggle} className="lens-blur-panel">
      <fieldset className="lens-blur-controls" disabled={!value.enabled}>
        <legend className="visually-hidden">Lens Blur controls</legend>

        <AdjustmentSlider
          label="Amount"
          value={value.amount}
          min={0}
          max={100}
          defaultValue={50}
          onBegin={onBegin}
          onCommit={onCommit}
          onChange={(amount) => onChange({ ...value, amount })}
        />

        <div className="lens-blur-section">
          <div className="lens-blur-section__heading">
            <span>Bokeh</span>
          </div>
          <div
            className="lens-blur-bokeh"
            role="radiogroup"
            aria-label="Bokeh shape"
          >
            {BOKEH_OPTIONS.map((option, index) => {
              const selected = option.value === value.bokeh;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`${option.label} bokeh`}
                  title={option.label}
                  tabIndex={selected ? 0 : -1}
                  className={selected ? "is-active" : ""}
                  onClick={() => commitPatch({ bokeh: option.value })}
                  onKeyDown={(event) => selectAdjacentBokeh(event, index)}
                >
                  <span
                    className={`lens-blur-bokeh__shape lens-blur-bokeh__shape--${option.value}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </div>

        <AdjustmentSlider
          label="Boost"
          value={value.boost}
          min={0}
          max={100}
          defaultValue={0}
          onBegin={onBegin}
          onCommit={onCommit}
          onChange={(boost) => onChange({ ...value, boost })}
        />

        <div className="lens-blur-section lens-blur-focal-section">
          <div className="lens-blur-section__heading">
            <span>Focal Range</span>
            <button
              type="button"
              className="lens-blur-subject-button"
              title="Place focus at the portrait center"
              onClick={() => commitPatch({ focusX: 0.5, focusY: 0.42 })}
            >
              Subject Focus
            </button>
          </div>

          <button
            type="button"
            className="lens-blur-focus-map"
            style={focusStyle}
            aria-label={`Focus point at ${Math.round(value.focusX * 100)} percent horizontal and ${Math.round(value.focusY * 100)} percent vertical`}
            aria-describedby={refineHintId}
            title="Drag to position focus. Use arrow keys for precise control."
            onPointerDown={(event) => {
              event.preventDefault();
              activePointerRef.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              beginFocusInteraction();
              updateFocusFromPointer(event);
            }}
            onPointerMove={(event) => {
              if (activePointerRef.current !== event.pointerId) return;
              updateFocusFromPointer(event);
            }}
            onPointerUp={(event) => {
              if (activePointerRef.current !== event.pointerId) return;
              updateFocusFromPointer(event);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              commitFocusInteraction();
            }}
            onPointerCancel={commitFocusInteraction}
            onLostPointerCapture={commitFocusInteraction}
            onKeyDown={handleFocusKeyDown}
            onKeyUp={(event) => {
              if (
                event.key.startsWith("Arrow") ||
                event.key === "Home"
              ) {
                commitFocusInteraction();
              }
            }}
            onBlur={commitFocusInteraction}
          >
            <span className="lens-blur-focus-map__far" aria-hidden="true" />
            <span className="lens-blur-focus-map__mid" aria-hidden="true" />
            <span className="lens-blur-focus-map__near" aria-hidden="true" />
            <span className="lens-blur-focus-map__range" aria-hidden="true" />
            <span className="lens-blur-focus-map__crosshair" aria-hidden="true" />
          </button>

          <div className="lens-blur-focus-readout" aria-live="polite">
            <span>Near</span>
            <output>
              Focus {Math.round(value.focusX * 100)}, {Math.round(value.focusY * 100)}
            </output>
            <span>Far</span>
          </div>

          <AdjustmentSlider
            label="Range"
            value={value.focusRange}
            min={1}
            max={100}
            defaultValue={50}
            onBegin={onBegin}
            onCommit={onCommit}
            onChange={(focusRange) => onChange({ ...value, focusRange })}
          />

          <p id={refineHintId} className="lens-blur-refine-hint">
            <strong>Refine</strong>
            Drag the focus point, or use the arrow keys. Hold Shift for larger steps.
          </p>
        </div>
      </fieldset>
    </Panel>
  );
}

export default LensBlurPanel;
