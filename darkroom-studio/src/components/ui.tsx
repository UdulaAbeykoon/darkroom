import {
  type CSSProperties,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ChevronDown, X, type LucideIcon } from "lucide-react";

export function IconButton({
  icon: Icon,
  label,
  active,
  badge,
  className = "",
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  badge?: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={label}
      {...buttonProps}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
      {badge ? <span className="icon-button__badge">{badge}</span> : null}
    </button>
  );
}

export function AdjustmentSlider({
  label,
  value,
  min,
  max,
  step = 1,
  defaultValue = 0,
  onChange,
  onBegin,
  onCommit,
  formatValue,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange: (value: number) => void;
  onBegin?: () => void;
  onCommit?: () => void;
  formatValue?: (value: number) => string;
  disabled?: boolean;
}) {
  const [displayValue, setDisplayValue] = useState(value);
  const [editingNumber, setEditingNumber] = useState(false);
  const [numberText, setNumberText] = useState(String(value));
  const cancelNumberRef = useRef(false);
  const interactionRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const latestValueRef = useRef(value);
  const deliveredValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const commitRef = useRef(onCommit);
  onChangeRef.current = onChange;
  commitRef.current = onCommit;

  const flushPendingChange = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const next = latestValueRef.current;
    if (next === deliveredValueRef.current) return;
    deliveredValueRef.current = next;
    onChangeRef.current(next);
  };

  const scheduleChange = (next: number) => {
    latestValueRef.current = next;
    setDisplayValue(next);
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const scheduled = latestValueRef.current;
      if (scheduled === deliveredValueRef.current) return;
      deliveredValueRef.current = scheduled;
      onChangeRef.current(scheduled);
    });
  };

  useEffect(() => {
    deliveredValueRef.current = value;
    if (interactionRef.current) return;
    latestValueRef.current = value;
    setDisplayValue(value);
  }, [value]);

  const percent = ((displayValue - min) / (max - min)) * 100;
  const display =
    formatValue?.(displayValue) ??
    (displayValue > 0
      ? `+${Number(displayValue.toFixed(2))}`
      : `${Number(displayValue.toFixed(2))}`);
  const style = { "--slider-progress": `${percent}%` } as CSSProperties;
  const beginInteraction = () => {
    if (interactionRef.current) return;
    interactionRef.current = true;
    onBegin?.();
  };
  const commitInteraction = () => {
    if (!interactionRef.current) return;
    flushPendingChange();
    interactionRef.current = false;
    commitRef.current?.();
  };

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const pending = latestValueRef.current;
      if (pending !== deliveredValueRef.current) {
        deliveredValueRef.current = pending;
        onChangeRef.current(pending);
      }
      if (interactionRef.current) {
        interactionRef.current = false;
        commitRef.current?.();
      }
    },
    [],
  );

  return (
    <label
      className={`adjustment-slider ${disabled ? "is-disabled" : ""}`}
      onDoubleClick={(event) => {
        if (disabled || (event.target as HTMLElement).closest(".adjustment-slider__number")) return;
        event.preventDefault();
        onBegin?.();
        latestValueRef.current = defaultValue;
        setDisplayValue(defaultValue);
        flushPendingChange();
        commitRef.current?.();
      }}
      title={`Double-click to reset ${label}`}
    >
      <span className="adjustment-slider__label">{label}</span>
      <input
        className="adjustment-slider__input"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={displayValue}
        style={style}
        disabled={disabled}
        onPointerDown={beginInteraction}
        onInput={(event) => scheduleChange(Number(event.currentTarget.value))}
        onPointerUp={commitInteraction}
        onPointerCancel={commitInteraction}
        onLostPointerCapture={commitInteraction}
        onBlur={commitInteraction}
        onKeyDown={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
            beginInteraction();
          }
        }}
        onKeyUp={commitInteraction}
      />
      {editingNumber ? (
        <input className="text-input adjustment-slider__number" type="number" aria-label={`${label} value`}
          min={min} max={max} step={step} value={numberText} autoFocus
          onFocus={event => event.currentTarget.select()}
          onClick={event => event.stopPropagation()}
          onChange={event => setNumberText(event.target.value)}
          onBlur={() => {
            const number = Number(numberText);
            if (!cancelNumberRef.current && numberText.trim() && Number.isFinite(number)) {
              beginInteraction(); scheduleChange(Number(Math.min(max, Math.max(min, Math.round(number / step) * step)).toFixed(6))); commitInteraction();
            }
            cancelNumberRef.current = false; setEditingNumber(false);
          }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === "Escape") { cancelNumberRef.current = true; event.currentTarget.blur(); }
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          }} />
      ) : (
        <button type="button" className="adjustment-slider__value" disabled={disabled}
          aria-label={`Set ${label} value`} title={`Enter an exact value for ${label}`}
          onClick={event => { event.preventDefault(); setNumberText(String(Number(displayValue.toFixed(3)))); setEditingNumber(true); }}>
          {display}
        </button>
      )}
    </label>
  );
}

export function Panel({
  title,
  children,
  defaultOpen = false,
  action,
  className = "",
}: PropsWithChildren<{
  title: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  className?: string;
}>) {
  return (
    <details className={`inspector-panel ${className}`} open={defaultOpen}>
      <summary>
        <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>{title}</span>
        {action ? (
          <span className="inspector-panel__action" onClick={(event) => event.preventDefault()}>
            {action}
          </span>
        ) : null}
      </summary>
      <div className="inspector-panel__body">{children}</div>
    </details>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented-control" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={option.value === value ? "is-active" : ""}
          title={option.title}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
                event.key,
              )
            ) {
              return;
            }
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="radio"]',
              ) ?? [],
            );
            const currentIndex = buttons.indexOf(event.currentTarget);
            let nextIndex = currentIndex;
            if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = buttons.length - 1;
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
            } else {
              nextIndex = (currentIndex + 1) % buttons.length;
            }
            buttons[nextIndex]?.focus();
            const next = options[nextIndex];
            if (next) onChange(next.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  footer,
  size = "medium",
}: PropsWithChildren<{
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  size?: "small" | "medium" | "large";
}>) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".topbar, .workspace, .app-shell > .filmstrip",
      ),
    );
    const previousInert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    const frame = requestAnimationFrame(() => {
      const firstControl = dialogRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      (firstControl ?? dialogRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      background.forEach((element, index) => {
        element.inert = previousInert[index];
        element.removeAttribute("aria-hidden");
      });
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => !element.hidden && element.offsetParent !== null);
          if (!controls.length) {
            event.preventDefault();
            event.currentTarget.focus();
            return;
          }
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: PropsWithChildren<{ label: string; hint?: string }>) {
  const labelId = useId();
  return (
    <div className="field" role="group" aria-labelledby={labelId}>
      <span className="field__label" id={labelId}>
        {label}
      </span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput(
  props: InputHTMLAttributes<HTMLInputElement> & { label?: string },
) {
  const { label, className = "", ...inputProps } = props;
  if (!label) {
    return (
      <span className="text-input-wrap">
        <input className={`text-input ${className}`} {...inputProps} />
      </span>
    );
  }
  return (
    <label className="text-input-wrap">
      <span>{label}</span>
      <input className={`text-input ${className}`} {...inputProps} />
    </label>
  );
}
