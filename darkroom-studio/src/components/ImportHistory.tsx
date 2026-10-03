import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Clock3, MoreHorizontal, Trash2 } from "lucide-react";
import type { ImportGroup } from "../lib/importHistory";
import "./ImportHistory.css";

type MenuState = {
  groupId: string;
  x: number;
  y: number;
};

export function formatImportGroupDate({ importedAt, legacy }: Pick<ImportGroup, "importedAt" | "legacy">): string | null {
  if (!importedAt) return null;
  const date = new Date(importedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(legacy ? { timeZone: "UTC" } : { hour: "numeric", minute: "2-digit" }),
  });
}

function ImportActionsMenu({
  menu,
  group,
  id,
  onClose,
  onDelete,
}: {
  menu: MenuState;
  group: ImportGroup;
  id: string;
  onClose: () => void;
  onDelete: (groupId: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const label = group.legacy ? "Earlier imports" : group.label;

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        left: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)),
      });
    }
    actionRef.current?.focus({ preventScroll: true });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      id={id}
      ref={menuRef}
      className="import-history-menu"
      role="menu"
      aria-label={`${label} actions`}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          actionRef.current?.focus();
        } else if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <button
        ref={actionRef}
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onDelete(group.id);
        }}
      >
        <Trash2 size={14} aria-hidden="true" />
        <span>Delete import…</span>
      </button>
    </div>,
    document.body,
  );
}

export default function ImportHistory({
  imports,
  source,
  onSourceChange,
  onDeleteImport,
  disabled = false,
}: {
  imports: ImportGroup[];
  source: string;
  onSourceChange: (source: string) => void;
  onDeleteImport: (groupId: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const menuId = useId();
  const [expanded, setExpanded] = useState(true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const groups = useMemo(
    () => [...imports].sort((a, b) =>
      (b.importedAt ?? "").localeCompare(a.importedAt ?? "") || a.id.localeCompare(b.id),
    ),
    [imports],
  );
  const menuGroup = menu ? groups.find((group) => group.id === menu.groupId) : null;
  const closeMenu = useCallback(() => {
    setMenu(null);
    if (menuTriggerRef.current?.isConnected) menuTriggerRef.current.focus({ preventScroll: true });
    menuTriggerRef.current = null;
  }, []);

  useEffect(() => {
    if (menu && (disabled || !menuGroup || !expanded)) closeMenu();
  }, [disabled, menu, menuGroup, expanded, closeMenu]);

  const openAtButton = (groupId: string, trigger: HTMLButtonElement) => {
    if (disabled) return;
    const rect = trigger.getBoundingClientRect();
    menuTriggerRef.current = trigger;
    setMenu({ groupId, x: rect.left, y: rect.bottom + 4 });
  };

  const openFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, groupId: string) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openAtButton(groupId, event.currentTarget);
    }
  };

  return (
    <div className="import-history">
      <button
        type="button"
        className={`import-history__heading ${source.startsWith("import:") ? "has-selection" : ""}`}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => {
          closeMenu();
          setExpanded((value) => !value);
        }}
      >
        <Clock3 size={15} strokeWidth={1.6} aria-hidden="true" />
        <span>Previous Imports</span>
        <small aria-label={`${groups.length} import groups`}>{groups.length}</small>
        {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      <div id={listId} className="import-history__contents" hidden={!expanded}>
        {groups.length ? (
          <ul className="import-history__list" aria-label="Previous imports">
            {groups.map((group) => {
              const label = group.legacy ? "Earlier imports" : group.label;
              const importedDate = formatImportGroupDate(group);
              const count = `${group.photoIds.length} ${group.photoIds.length === 1 ? "photo" : "photos"}`;
              const active = source === `import:${group.id}`;
              const menuOpen = menu?.groupId === group.id;
              return (
                <li
                  className={`import-history__group ${active ? "is-active" : ""}`}
                  key={group.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (disabled) return;
                    const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".import-history__select");
                    if (!trigger) return;
                    menuTriggerRef.current = trigger;
                    setMenu({ groupId: group.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <button
                    type="button"
                    className="import-history__select"
                    aria-current={active ? "true" : undefined}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    title={[label, importedDate, count].filter(Boolean).join(" — ")}
                    onClick={() => onSourceChange(`import:${group.id}`)}
                    onKeyDown={(event) => openFromKeyboard(event, group.id)}
                  >
                    <strong>{label}</strong>
                    {importedDate ? <time dateTime={group.importedAt ?? undefined}>{importedDate}</time> : null}
                    <small>{count}</small>
                  </button>
                  <button
                    type="button"
                    className="import-history__actions"
                    aria-label={`Actions for ${label}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    disabled={disabled}
                    onClick={(event) => openAtButton(group.id, event.currentTarget)}
                  >
                    <MoreHorizontal size={15} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="import-history__empty">No previous imports.</p>}
      </div>
      {menu && menuGroup && expanded && !disabled ? (
        <ImportActionsMenu key={menu.groupId} id={menuId} menu={menu} group={menuGroup} onClose={closeMenu} onDelete={onDeleteImport} />
      ) : null}
    </div>
  );
}
