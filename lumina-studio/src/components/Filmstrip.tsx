import { memo } from "react";
import { Check, X } from "lucide-react";
import { useDevelopedPreview } from "../hooks/useDevelopedPreview";
import type { PhotoRecord } from "../types";

const FilmstripFrame = memo(function FilmstripFrame({
  photo,
  active,
  selected,
  onActivate,
}: {
  photo: PhotoRecord;
  active: boolean;
  selected: boolean;
  onActivate: (id: string, additive: boolean, range: boolean) => void;
}) {
  const preview = useDevelopedPreview(photo, 640, {
    fallbackUrl: photo.thumbnailUrl,
  });

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={active ? 0 : -1}
      className={[
        "filmstrip__frame",
        active ? "is-active" : "",
        selected ? "is-selected" : "",
      ].join(" ")}
      onClick={(event) =>
        onActivate(photo.id, event.metaKey || event.ctrlKey, event.shiftKey)
      }
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const frames = Array.from(
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
            '[role="option"]',
          ) ?? [],
        );
        const current = frames.indexOf(event.currentTarget);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? frames.length - 1
              : event.key === "ArrowLeft"
                ? Math.max(0, current - 1)
                : Math.min(frames.length - 1, current + 1);
        frames[next]?.click();
        requestAnimationFrame(() => frames[next]?.focus());
      }}
      title={photo.name}
    >
      <img
        ref={preview.imageRef}
        src={preview.src}
        alt=""
        draggable={false}
        loading="lazy"
      />
      {photo.flag === "pick" ? (
        <span className="filmstrip__flag filmstrip__flag--pick">
          <Check size={10} />
        </span>
      ) : null}
      {photo.flag === "reject" ? (
        <span className="filmstrip__flag filmstrip__flag--reject">
          <X size={10} />
        </span>
      ) : null}
      {photo.rating ? (
        <span className="filmstrip__rating">{"•".repeat(photo.rating)}</span>
      ) : null}
    </button>
  );
});

export default function Filmstrip({
  photos,
  activeId,
  selectedIds,
  onActivate,
}: {
  photos: PhotoRecord[];
  activeId: string | null;
  selectedIds: Set<string>;
  onActivate: (id: string, additive: boolean, range: boolean) => void;
}) {
  if (!photos.length) return null;

  return (
    <div className="filmstrip" aria-label="Filmstrip">
      <div className="filmstrip__count">
        <strong>{photos.findIndex((photo) => photo.id === activeId) + 1 || "—"}</strong>
        <span>/ {photos.length}</span>
      </div>
      <div className="filmstrip__rail" role="listbox">
        {photos.map((photo) => (
          <FilmstripFrame
            key={photo.id}
            photo={photo}
            active={photo.id === activeId}
            selected={selectedIds.has(photo.id)}
            onActivate={onActivate}
          />
        ))}
      </div>
    </div>
  );
}
