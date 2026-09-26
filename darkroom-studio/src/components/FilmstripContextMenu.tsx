import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";

export type FilmstripMenuItem =
  | { id: string; type: "separator" }
  | {
      id: string;
      type: "item";
      label: string;
      icon?: LucideIcon;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      tone?: "default" | "danger";
      onSelect?: () => void;
      children?: FilmstripMenuItem[];
    };

type Props = {
  x: number;
  y: number;
  label: string;
  items: FilmstripMenuItem[];
  onClose: () => void;
};

const VIEWPORT_GUTTER = 8;

function nextMenuButton(
  root: HTMLElement,
  current: HTMLElement,
  direction: 1 | -1,
) {
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>(
      ':scope > .filmstrip-menu__entry > [role^="menuitem"]:not(:disabled)',
    ),
  );
  const index = buttons.indexOf(current as HTMLButtonElement);
  const nextIndex = index < 0 ? 0 : (index + direction + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

function MenuItems({
  items,
  onClose,
  nested = false,
}: {
  items: FilmstripMenuItem[];
  onClose: () => void;
  nested?: boolean;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = event.target as HTMLElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      nextMenuButton(event.currentTarget, current, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ':scope > .filmstrip-menu__entry > [role^="menuitem"]:not(:disabled)',
      );
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
      return;
    }
    if (event.key === "ArrowRight") {
      const submenu = current
        .closest(".filmstrip-menu__entry")
        ?.querySelector<HTMLDivElement>(":scope > .filmstrip-menu__submenu");
      if (submenu) {
        event.preventDefault();
        submenu.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
      }
      return;
    }
    if (event.key === "ArrowLeft" && nested) {
      event.preventDefault();
      event.currentTarget
        .closest(".filmstrip-menu__entry")
        ?.querySelector<HTMLButtonElement>(":scope > button")
        ?.focus();
    }
  };

  return (
    <div
      className={nested ? "filmstrip-menu__submenu" : "filmstrip-menu__items"}
      role={nested ? "menu" : undefined}
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => {
        if (item.type === "separator") {
          return <div key={item.id} className="filmstrip-menu__separator" role="separator" />;
        }
        const Icon = item.icon;
        const hasChildren = Boolean(item.children?.length);
        return (
          <div className="filmstrip-menu__entry" key={item.id}>
            <button
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-haspopup={hasChildren ? "menu" : undefined}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              className={item.tone === "danger" ? "is-danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                if (hasChildren) return;
                item.onSelect?.();
                onClose();
              }}
            >
              <span className="filmstrip-menu__check" aria-hidden="true">
                {item.checked ? <Check size={13} strokeWidth={2.3} /> : Icon ? <Icon size={13} /> : null}
              </span>
              <span className="filmstrip-menu__label">{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              {hasChildren ? <ChevronRight className="filmstrip-menu__chevron" size={13} /> : null}
            </button>
            {hasChildren ? (
              <MenuItems items={item.children!} onClose={onClose} nested />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function FilmstripContextMenu({ x, y, label, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef(document.activeElement as HTMLElement | null);
  const [position, setPosition] = useState({
    left: x,
    top: y,
    opensLeft: false,
    ready: false,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(
        VIEWPORT_GUTTER,
        Math.min(x, window.innerWidth - rect.width - VIEWPORT_GUTTER),
      ),
      top: Math.max(
        VIEWPORT_GUTTER,
        Math.min(y, window.innerHeight - rect.height - VIEWPORT_GUTTER),
      ),
      opensLeft: x + rect.width + 230 > window.innerWidth - VIEWPORT_GUTTER,
      ready: true,
    });
    const focusFrame = requestAnimationFrame(() => {
      menu.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [x, y]);

  useEffect(() => {
    const closeWhenOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", closeWhenOutside, true);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeWhenOutside, true);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={`filmstrip-menu ${position.opensLeft ? "opens-left" : ""}`}
      role="menu"
      aria-label={label}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}
