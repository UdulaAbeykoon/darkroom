import {
  Check,
  Flag,
  HardDrive,
  Search,
  Star,
  Upload,
  X,
} from "lucide-react";
import { memo } from "react";
import { useDevelopedPreview } from "../hooks/useDevelopedPreview";
import type { LibraryView, PhotoRecord } from "../types";
import "./LibraryEmptyState.css";

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PhotoCard = memo(function PhotoCard({
  photo,
  active,
  selected,
  view,
  onSelect,
  onOpen,
}: {
  photo: PhotoRecord;
  active: boolean;
  selected: boolean;
  view: Exclude<LibraryView, "detail">;
  onSelect: (id: string, additive: boolean, range: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const preview = useDevelopedPreview(photo, 640, {
    fallbackUrl: photo.thumbnailUrl,
  });

  return (
    <article
      className={`photo-card photo-card--${view} ${active ? "is-active" : ""} ${
        selected ? "is-selected" : ""
      }`}
      role="option"
      aria-selected={selected}
      onClick={(event) =>
        onSelect(photo.id, event.metaKey || event.ctrlKey, event.shiftKey)
      }
      onDoubleClick={() => onOpen(photo.id)}
      tabIndex={active ? 0 : -1}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(photo.id);
        else if (event.key === " ") {
          event.preventDefault();
          onSelect(photo.id, event.metaKey || event.ctrlKey, event.shiftKey);
        } else if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          const options = Array.from(
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
              '[role="option"]',
            ) ?? [],
          );
          const current = options.indexOf(event.currentTarget);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? Math.max(0, current - 1)
                  : Math.min(options.length - 1, current + 1);
          options[next]?.click();
          requestAnimationFrame(() => options[next]?.focus());
        }
      }}
    >
      <div
        className="photo-card__image"
        style={
          view === "photo-grid"
            ? {
                aspectRatio: `${Math.max(1, photo.width)} / ${Math.max(
                  1,
                  photo.height,
                )}`,
              }
            : undefined
        }
      >
        <img
          ref={preview.imageRef}
          src={preview.src}
          alt={photo.name}
          draggable={false}
          loading="lazy"
        />
        <span className="photo-card__dimensions">
          {photo.width} × {photo.height}
        </span>
        {selected ? (
          <span className="photo-card__selection">
            <Check size={12} strokeWidth={2.5} />
          </span>
        ) : null}
      </div>
      <footer className="photo-card__footer">
        <div>
          <strong title={photo.name}>{photo.name}</strong>
          <span>{formatFileSize(photo.size)}</span>
        </div>
        <div className="photo-card__markers" aria-label={`${photo.rating} star rating`}>
          {photo.flag === "pick" ? <Flag className="is-pick" size={11} fill="currentColor" /> : null}
          {photo.flag === "reject" ? <X className="is-reject" size={11} /> : null}
          {photo.rating ? (
            <span>
              <Star size={10} fill="currentColor" /> {photo.rating}
            </span>
          ) : null}
        </div>
      </footer>
    </article>
  );
});

const LoupeView = memo(function LoupeView({
  photo,
  onOpen,
}: {
  photo: PhotoRecord;
  onOpen: (id: string) => void;
}) {
  const preview = useDevelopedPreview(photo, 1_600, {
    eager: true,
    fallbackUrl: photo.objectUrl,
  });

  return (
    <main
      className="library-loupe"
      tabIndex={0}
      aria-label={`Open ${photo.name} in Develop`}
      onDoubleClick={() => onOpen(photo.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(photo.id);
      }}
    >
      <img ref={preview.imageRef} src={preview.src} alt={photo.name} />
      <div className="library-loupe__caption">
        <strong>{photo.name}</strong>
        <span>
          {photo.metadata.camera ?? "Unknown camera"} · {photo.width} ×{" "}
          {photo.height}
        </span>
      </div>
    </main>
  );
});

export default function LibraryWorkspace({
  photos,
  hasPhotos = false,
  activeId,
  selectedIds,
  view,
  onSelect,
  onOpen,
  onImport,
  onLoadSample,
}: {
  photos: PhotoRecord[];
  hasPhotos?: boolean;
  activeId: string | null;
  selectedIds: Set<string>;
  view: LibraryView;
  onSelect: (id: string, additive: boolean, range: boolean) => void;
  onOpen: (id: string) => void;
  onImport: () => void;
  onLoadSample: () => void;
}) {
  if (!photos.length) {
    if (hasPhotos) {
      return (
        <main className="empty-library empty-library--filtered">
          <div className="empty-library__search-icon" aria-hidden="true">
            <Search size={24} strokeWidth={1.5} />
          </div>
          <h1>No photos in this view</h1>
          <p className="empty-library__copy">
            Try a different search, filter, or album to find your photos.
          </p>
        </main>
      );
    }

    return (
      <main className="empty-library">
        <div className="empty-library__contact-sheet" aria-hidden="true">
          <div className="empty-library__frame empty-library__frame--back">
            <div className="empty-library__frame-image">
              <span className="empty-library__mountain" />
            </div>
            <span className="empty-library__frame-line" />
          </div>
          <div className="empty-library__frame empty-library__frame--front">
            <div className="empty-library__frame-image">
              <span className="empty-library__sun" />
              <span className="empty-library__mountain" />
              <span className="empty-library__foreground" />
            </div>
            <span className="empty-library__frame-line" />
            <span className="empty-library__frame-dot" />
          </div>
          <span className="empty-library__crop empty-library__crop--top" />
          <span className="empty-library__crop empty-library__crop--bottom" />
        </div>
        <h1>Your next great edit<br />starts here.</h1>
        <p className="empty-library__copy">
          A little light. A different perspective. Import your photos
          and make every frame your own.
        </p>
        <div className="empty-library__actions">
          <button type="button" className="button button--primary" onClick={onImport}>
            <Upload size={15} aria-hidden="true" />
            Import photos
          </button>
          <button type="button" className="button button--quiet" onClick={onLoadSample}>
            Try a sample photo
          </button>
        </div>
        <div className="empty-library__formats">
          JPEG, PNG, WebP and RAW
        </div>
        <p className="empty-library__privacy">
          <HardDrive size={13} aria-hidden="true" />
          Your photos stay on your device. Originals stay untouched.
        </p>
      </main>
    );
  }

  if (view === "detail") {
    const active = photos.find((photo) => photo.id === activeId) ?? photos[0];
    return <LoupeView photo={active} onOpen={onOpen} />;
  }

  return (
    <main
      className={`library-grid library-grid--${view}`}
      role="listbox"
      aria-label={view === "square-grid" ? "Square photo grid" : "Photo grid"}
      aria-multiselectable="true"
    >
      {photos.map((photo) => (
        <PhotoCard
          key={photo.id}
          photo={photo}
          active={photo.id === activeId}
          selected={selectedIds.has(photo.id)}
          view={view}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
    </main>
  );
}
