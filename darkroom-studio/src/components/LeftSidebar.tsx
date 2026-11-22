import { useMemo, useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  FolderHeart,
  FolderPlus,
  History,
  Image,
  Library,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";
import { BUILT_IN_PRESETS } from "../defaults";
import { useDevelopedPreview } from "../hooks/useDevelopedPreview";
import type { ImportGroup } from "../lib/importHistory";
import ImportHistory from "./ImportHistory";
import type {
  Collection,
  DevelopPreset,
  EditSnapshot,
  PhotoRecord,
  WorkspaceMode,
} from "../types";

function NavigatorPreview({ photo }: { photo: PhotoRecord }) {
  const preview = useDevelopedPreview(photo, 640, {
    eager: true,
    fallbackUrl: photo.thumbnailUrl,
  });

  return (
    <img
      ref={preview.imageRef}
      src={preview.src}
      alt="Current photograph navigator preview"
      draggable={false}
    />
  );
}

function NavItem({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: typeof Library;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-nav-item ${active ? "is-active" : ""}`}
      onClick={onClick}
    >
      <Icon size={15} strokeWidth={1.6} />
      <span>{label}</span>
      {typeof count === "number" ? <small>{count}</small> : null}
    </button>
  );
}

function LibrarySidebar({
  photos,
  source,
  collections,
  onSourceChange,
  onCreateCollection,
  importGroups,
  onDeleteImport,
  importActionsDisabled,
}: {
  photos: PhotoRecord[];
  source: string;
  collections: Collection[];
  onSourceChange: (source: string) => void;
  onCreateCollection: (name: string) => void;
  importGroups: ImportGroup[];
  onDeleteImport: (groupId: string) => void;
  importActionsDisabled?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const picks = photos.filter((photo) => photo.flag === "pick").length;
  const rejected = photos.filter((photo) => photo.flag === "reject").length;
  const fiveStars = photos.filter((photo) => photo.rating === 5).length;

  return (
    <>
      <div className="sidebar-section">
        <div className="sidebar-section__title">Catalog</div>
        <NavItem
          icon={Image}
          label="All Photographs"
          count={photos.length}
          active={source === "all"}
          onClick={() => onSourceChange("all")}
        />
        <ImportHistory
          imports={importGroups}
          source={source}
          onSourceChange={onSourceChange}
          onDeleteImport={onDeleteImport}
          disabled={importActionsDisabled}
        />
        <NavItem
          icon={Check}
          label="Picks"
          count={picks}
          active={source === "picks"}
          onClick={() => onSourceChange("picks")}
        />
        <NavItem
          icon={Star}
          label="Five stars"
          count={fiveStars}
          active={source === "five-stars"}
          onClick={() => onSourceChange("five-stars")}
        />
        <NavItem
          icon={X}
          label="Rejected"
          count={rejected}
          active={source === "rejected"}
          onClick={() => onSourceChange("rejected")}
        />
      </div>
      <div className="sidebar-section sidebar-section--grow">
        <div className="sidebar-section__title">
          <span>Collections</span>
          <button type="button" title="New collection" onClick={() => setCreating(true)}>
            <Plus size={13} />
          </button>
        </div>
        {collections.map((collection) => (
          <NavItem
            key={collection.id}
            icon={FolderHeart}
            label={collection.name}
            count={photos.filter((photo) => photo.collectionIds.includes(collection.id)).length}
            active={source === `collection:${collection.id}`}
            onClick={() => onSourceChange(`collection:${collection.id}`)}
          />
        ))}
        {!collections.length && !creating ? (
          <button
            type="button"
            className="sidebar-empty-action"
            onClick={() => setCreating(true)}
          >
            <FolderPlus size={15} />
            Create Collection
          </button>
        ) : null}
        {creating ? (
          <form
            className="new-collection"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) onCreateCollection(name.trim());
              setName("");
              setCreating(false);
            }}
          >
            <input
              autoFocus
              value={name}
              placeholder="Album name"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setCreating(false);
              }}
            />
            <button type="submit">Add</button>
          </form>
        ) : null}
      </div>
      <div className="storage-note">
        <Archive size={14} />
        <div>
          <strong>Local catalog</strong>
          <span>Originals never leave this device</span>
        </div>
      </div>
    </>
  );
}

function DevelopSidebar({
  photo,
  photos,
  collections,
  snapshots,
  historyCount,
  onApplyPreset,
  onPreviewPreset,
  activePresetId,
  presetAmount,
  onPresetAmountChange,
  onPresetAmountCommit,
  onCreateSnapshot,
  onRestoreSnapshot,
  onCopySettings,
  onPasteSettings,
  canPasteSettings,
  onSourceChange,
}: {
  photo: PhotoRecord | null;
  photos: PhotoRecord[];
  collections: Collection[];
  snapshots: EditSnapshot[];
  historyCount: number;
  onApplyPreset: (preset: DevelopPreset) => void;
  onPreviewPreset?: (preset: DevelopPreset | null) => void;
  activePresetId: string | null;
  presetAmount: number;
  onPresetAmountChange: (amount: number) => void;
  onPresetAmountCommit: () => void;
  onCreateSnapshot: () => void;
  onRestoreSnapshot: (snapshot: EditSnapshot) => void;
  onCopySettings: () => void;
  onPasteSettings: () => void;
  canPasteSettings: boolean;
  onSourceChange: (source: string) => void;
}) {
  const [search, setSearch] = useState("");
  const presets = useMemo(
    () =>
      BUILT_IN_PRESETS.filter((preset) =>
        `${preset.name} ${preset.group} ${preset.description}`.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [search],
  );
  const presetGroups = useMemo(() => {
    const groups = new Map<string, DevelopPreset[]>();
    for (const preset of presets) {
      const group = groups.get(preset.group) ?? [];
      group.push(preset);
      groups.set(preset.group, group);
    }
    return [...groups.entries()];
  }, [presets]);
  const [collapsedPresetGroups, setCollapsedPresetGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const isFilteringPresets = Boolean(search.trim());
  const togglePresetGroup = (group: string) => {
    setCollapsedPresetGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  const activePreset = BUILT_IN_PRESETS.find(
    (preset) => preset.id === activePresetId,
  );

  return (
    <>
      <section className="navigator-panel" aria-label="Navigator">
        <header>
          <strong>Navigator</strong>
        </header>
        <div className="navigator-panel__preview">
          {photo ? <NavigatorPreview photo={photo} /> : null}
        </div>
      </section>
      <section className="develop-preset-summary" aria-label="Current preset">
        <div><span>Preset:</span><strong> {activePreset?.name ?? "Custom"}</strong></div>
        <label>
          <span>Amount</span>
          <input
            type="range"
            min="0"
            max="200"
            value={presetAmount}
            disabled={!activePreset || Boolean(activePreset.profile)}
            aria-label="Preset amount"
            title={activePreset?.profile ? "This preset applies a fixed color profile" : undefined}
            onInput={(event) =>
              onPresetAmountChange(Number(event.currentTarget.value))
            }
            onPointerUp={onPresetAmountCommit}
            onKeyUp={onPresetAmountCommit}
            onBlur={onPresetAmountCommit}
          />
          <output>{presetAmount}</output>
        </label>
      </section>
      <div className="develop-sidebar__scroll">
      <details className="develop-sidebar-section" open>
        <summary><ChevronDown size={14} /><span>Presets</span><small>{BUILT_IN_PRESETS.length}</small></summary>
      <div className="preset-search">
        <Search size={14} />
        <input
          value={search}
          placeholder="Search presets"
          aria-label="Search presets"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
        <div className="preset-list" aria-label="Preset groups">
          {presetGroups.map(([group, groupPresets]) => {
            const collapsed = !isFilteringPresets && collapsedPresetGroups.has(group);
            const groupId = `left-preset-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            return (
              <section className="preset-group" key={group}>
                <button
                  type="button"
                  className="preset-group__header"
                  aria-expanded={!collapsed}
                  aria-controls={groupId}
                  onClick={() => togglePresetGroup(group)}
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span>{group}</span>
                  <small>{groupPresets.length}</small>
                </button>
                <div
                  id={groupId}
                  className="preset-group__items"
                  hidden={collapsed}
                >
                  {groupPresets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`preset-row ${activePresetId === preset.id ? "is-active" : ""}`}
                      aria-pressed={activePresetId === preset.id}
                      disabled={!photo}
                      onClick={() => {
                        onPreviewPreset?.(null);
                        onApplyPreset(preset);
                      }}
                      onPointerEnter={() => onPreviewPreset?.(preset)}
                      onPointerLeave={() => onPreviewPreset?.(null)}
                      onFocus={() => onPreviewPreset?.(preset)}
                      onBlur={() => onPreviewPreset?.(null)}
                      title={preset.description}
                    >
                      <span className={`preset-swatch preset-swatch--${preset.id}`} />
                      <span>
                        <strong>{preset.name}</strong>
                        <small>{preset.group}</small>
                      </span>
                      <ChevronRight size={13} />
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        {!presets.length ? (
          <p className="sidebar-muted preset-list__empty">No presets match that search.</p>
        ) : null}
      </details>
      <details className="develop-sidebar-section">
        <summary><ChevronDown size={14} /><span>Snapshots</span><small>{snapshots.length}</small></summary>
        <div className="develop-sidebar-section__body">
        <button type="button" className="sidebar-empty-action" disabled={!photo} onClick={onCreateSnapshot}>
          <Plus size={13} /> Create snapshot
        </button>
        {snapshots.length ? (
          <div className="snapshot-list">
            {[...snapshots].reverse().map((snapshot) => (
              <button
                key={snapshot.id}
                type="button"
                onClick={() => onRestoreSnapshot(snapshot)}
              >
                <span>{snapshot.label}</span>
                <time>
                  {new Date(snapshot.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </button>
            ))}
          </div>
        ) : (
          <p className="sidebar-muted">Save a named version of the current edit.</p>
        )}
        </div>
      </details>
      <details className="develop-sidebar-section">
        <summary><ChevronDown size={14} /><span>History</span><History size={12} /></summary>
        <div className="develop-sidebar-section__body">
        <div className="history-summary">
          <span className={historyCount ? "is-live" : ""} />
          <div>
            <strong>
              {historyCount
                ? `${historyCount} ${historyCount === 1 ? "edit step" : "edit steps"}`
                : "Imported"}
            </strong>
            <small>Non-destructive</small>
          </div>
        </div>
        </div>
      </details>
      <details className="develop-sidebar-section">
        <summary><ChevronDown size={14} /><span>Collections</span><FolderHeart size={12} /></summary>
        <div className="develop-sidebar-section__body">
        {collections.length ? collections.map((collection) => (
          <NavItem
            key={collection.id}
            icon={FolderHeart}
            label={collection.name}
            count={photos.filter((item) => item.collectionIds.includes(collection.id)).length}
            onClick={() => onSourceChange(`collection:${collection.id}`)}
          />
        )) : <p className="sidebar-muted">No collections</p>}
        </div>
      </details>
      </div>
      <div className="panel-footer" aria-label="Develop clipboard actions">
        <button type="button" disabled={!photo} onClick={onCopySettings}>Copy…</button>
        <button type="button" disabled={!photo || !canPasteSettings} onClick={onPasteSettings}>Paste</button>
      </div>
    </>
  );
}

export default function LeftSidebar({
  mode,
  photos,
  photo,
  source,
  collections,
  snapshots,
  historyCount,
  onSourceChange,
  onCreateCollection,
  onApplyPreset,
  onPreviewPreset,
  activePresetId,
  presetAmount,
  onPresetAmountChange,
  onPresetAmountCommit,
  onCreateSnapshot,
  onRestoreSnapshot,
  onCopySettings,
  onPasteSettings,
  canPasteSettings,
  importGroups,
  onDeleteImport,
  importActionsDisabled,
}: {
  mode: WorkspaceMode;
  photos: PhotoRecord[];
  photo: PhotoRecord | null;
  source: string;
  collections: Collection[];
  snapshots: EditSnapshot[];
  historyCount: number;
  onSourceChange: (source: string) => void;
  onCreateCollection: (name: string) => void;
  onApplyPreset: (preset: DevelopPreset) => void;
  onPreviewPreset?: (preset: DevelopPreset | null) => void;
  activePresetId: string | null;
  presetAmount: number;
  onPresetAmountChange: (amount: number) => void;
  onPresetAmountCommit: () => void;
  onCreateSnapshot: () => void;
  onRestoreSnapshot: (snapshot: EditSnapshot) => void;
  onCopySettings: () => void;
  onPasteSettings: () => void;
  canPasteSettings: boolean;
  importGroups: ImportGroup[];
  onDeleteImport: (groupId: string) => void;
  importActionsDisabled?: boolean;
}) {
  return (
    <aside className={`left-sidebar left-sidebar--${mode}`} aria-label={mode === "develop" ? "Navigator and presets" : "Catalog navigation"}>
      {mode === "develop" ? (
        <DevelopSidebar
          photo={photo}
          photos={photos}
          collections={collections}
          snapshots={snapshots}
          historyCount={historyCount}
          onApplyPreset={onApplyPreset}
          onPreviewPreset={onPreviewPreset}
          activePresetId={activePresetId}
          presetAmount={presetAmount}
          onPresetAmountChange={onPresetAmountChange}
          onPresetAmountCommit={onPresetAmountCommit}
          onCreateSnapshot={onCreateSnapshot}
          onRestoreSnapshot={onRestoreSnapshot}
          onCopySettings={onCopySettings}
          onPasteSettings={onPasteSettings}
          canPasteSettings={canPasteSettings}
          onSourceChange={onSourceChange}
        />
      ) : (
        <LibrarySidebar
          photos={photos}
          source={source}
          collections={collections}
          onSourceChange={onSourceChange}
          onCreateCollection={onCreateCollection}
          importGroups={importGroups}
          onDeleteImport={onDeleteImport}
          importActionsDisabled={importActionsDisabled}
        />
      )}
    </aside>
  );
}
