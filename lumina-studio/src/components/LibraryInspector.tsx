import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Flag, Star, X } from "lucide-react";
import type {
  FlagState,
  HistogramData,
  PhotoMetadata,
  PhotoRecord,
} from "../types";
import Histogram from "./Histogram";
import "./LibraryInspector.css";

export type LibraryQuickAdjustment = "exposure" | "contrast";

export type LibraryMetadataPatch = Partial<
  Pick<PhotoMetadata, "caption" | "copyright">
>;

export interface LibraryInspectorProps {
  photo: PhotoRecord | null;
  histogram?: HistogramData | null;
  onQuickAdjust: (
    adjustment: LibraryQuickAdjustment,
    delta: number,
  ) => void;
  onRatingChange: (rating: number) => void;
  onFlagChange: (flag: FlagState) => void;
  onKeywordsChange: (keywords: string[]) => void;
  onMetadataChange: (patch: LibraryMetadataPatch) => void;
}

interface PanelProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}

function LibraryPanel({
  title,
  children,
  defaultOpen = false,
  count,
}: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className="library-panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="library-panel__summary">
        <ChevronDown aria-hidden="true" size={12} strokeWidth={2.2} />
        <span>{title}</span>
        {typeof count === "number" ? (
          <span className="library-panel__count">{count}</span>
        ) : null}
      </summary>
      <div className="library-panel__body">{children}</div>
    </details>
  );
}

interface StepControlProps {
  label: string;
  value: string;
  enabled: boolean;
  coarseStep: number;
  fineStep: number;
  onStep: (delta: number) => void;
}

function StepControl({
  label,
  value,
  enabled,
  coarseStep,
  fineStep,
  onStep,
}: StepControlProps) {
  const steps = [
    { glyph: "«", delta: -coarseStep, description: "large decrease" },
    { glyph: "‹", delta: -fineStep, description: "small decrease" },
    { glyph: "›", delta: fineStep, description: "small increase" },
    { glyph: "»", delta: coarseStep, description: "large increase" },
  ];

  return (
    <div className="library-step-control">
      <span className="library-step-control__label">{label}</span>
      <div className="library-step-control__buttons">
        {steps.map((step) => (
          <button
            key={step.glyph}
            type="button"
            aria-label={`${label}: ${step.description}`}
            disabled={!enabled}
            onClick={() => onStep(step.delta)}
          >
            {step.glyph}
          </button>
        ))}
      </div>
      <output className="library-step-control__value">{value}</output>
    </div>
  );
}

function formatSigned(value: number, digits = 0) {
  const rounded = Math.abs(value) < 10 ** -(digits + 1) ? 0 : value;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(digits)}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseKeywords(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[,;\n]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => {
      if (!keyword) return false;
      const normalized = keyword.toLocaleLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function sameKeywords(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((keyword, index) => keyword === right[index])
  );
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="library-metadata-row">
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

export default function LibraryInspector({
  photo,
  histogram = null,
  onQuickAdjust,
  onRatingChange,
  onFlagChange,
  onKeywordsChange,
  onMetadataChange,
}: LibraryInspectorProps) {
  const [keywordDraft, setKeywordDraft] = useState("");
  const [captionDraft, setCaptionDraft] = useState("");
  const [copyrightDraft, setCopyrightDraft] = useState("");

  useEffect(() => {
    setKeywordDraft(photo?.keywords.join(", ") ?? "");
    setCaptionDraft(photo?.metadata.caption ?? "");
    setCopyrightDraft(photo?.metadata.copyright ?? "");
  }, [photo]);

  const commitKeywords = () => {
    if (!photo) return;
    const keywords = parseKeywords(keywordDraft);
    setKeywordDraft(keywords.join(", "));
    if (!sameKeywords(keywords, photo.keywords)) onKeywordsChange(keywords);
  };

  const commitCaption = () => {
    if (!photo) return;
    const caption = captionDraft.trim();
    setCaptionDraft(caption);
    if (caption !== (photo.metadata.caption ?? "")) {
      onMetadataChange({ caption });
    }
  };

  const commitCopyright = () => {
    if (!photo) return;
    const copyright = copyrightDraft.trim();
    setCopyrightDraft(copyright);
    if (copyright !== (photo.metadata.copyright ?? "")) {
      onMetadataChange({ copyright });
    }
  };

  const dimensions = photo ? `${photo.width} × ${photo.height}` : "—";

  return (
    <aside
      className="right-inspector library-inspector"
      aria-label="Library inspector"
    >
      <section className="library-inspector__histogram-block">
        <div className="library-inspector__histogram-heading">
          <span>Histogram</span>
          <span>{photo ? "RGB" : "No photo selected"}</span>
        </div>
        <Histogram data={histogram} />
        <div className="library-inspector__histogram-readout">
          <span>{photo?.metadata.iso ? `ISO ${photo.metadata.iso}` : "ISO —"}</span>
          <span>
            {photo?.metadata.focalLength
              ? `${photo.metadata.focalLength} mm`
              : "— mm"}
          </span>
          <span>
            {photo?.metadata.aperture ? `f/${photo.metadata.aperture}` : "f/—"}
          </span>
          <span>{photo?.metadata.shutter ?? "— sec"}</span>
        </div>
      </section>

      <div className="library-inspector__panels">
        <LibraryPanel title="Quick Develop" defaultOpen>
          <div className="library-quick-develop">
            <div className="library-inspector__compact-field">
              <span>Saved Preset</span>
              <span className="library-inspector__select-display">
                Default Settings
              </span>
            </div>
            <div className="library-inspector__section-label">Tone Control</div>
            <StepControl
              label="Exposure"
              value={
                photo ? formatSigned(photo.edits.global.exposure, 2) : "—"
              }
              enabled={Boolean(photo)}
              coarseStep={1}
              fineStep={0.33}
              onStep={(delta) => onQuickAdjust("exposure", delta)}
            />
            <StepControl
              label="Contrast"
              value={photo ? formatSigned(photo.edits.global.contrast) : "—"}
              enabled={Boolean(photo)}
              coarseStep={20}
              fineStep={5}
              onStep={(delta) => onQuickAdjust("contrast", delta)}
            />

            <div className="library-inspector__section-label">Rating &amp; Flag</div>
            <div className="library-rating-flags">
              <div className="library-rating" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((rating) => {
                  const active = Boolean(photo && photo.rating >= rating);
                  return (
                    <button
                      key={rating}
                      type="button"
                      className={active ? "is-active" : undefined}
                      aria-label={`Set ${rating} star rating`}
                      aria-pressed={photo?.rating === rating}
                      disabled={!photo}
                      onClick={() =>
                        onRatingChange(photo?.rating === rating ? 0 : rating)
                      }
                    >
                      <Star
                        aria-hidden="true"
                        size={14}
                        strokeWidth={1.65}
                        fill={active ? "currentColor" : "none"}
                      />
                    </button>
                  );
                })}
              </div>
              <div className="library-flags" aria-label="Flag status">
                <button
                  type="button"
                  className={photo?.flag === "pick" ? "is-pick" : undefined}
                  aria-label="Flag as pick"
                  aria-pressed={photo?.flag === "pick"}
                  disabled={!photo}
                  onClick={() => onFlagChange("pick")}
                >
                  <Flag aria-hidden="true" size={13} fill="currentColor" />
                </button>
                <button
                  type="button"
                  className={
                    photo?.flag === "unflagged" ? "is-unflagged" : undefined
                  }
                  aria-label="Mark as unflagged"
                  aria-pressed={photo?.flag === "unflagged"}
                  disabled={!photo}
                  onClick={() => onFlagChange("unflagged")}
                >
                  <span aria-hidden="true">—</span>
                </button>
                <button
                  type="button"
                  className={photo?.flag === "reject" ? "is-reject" : undefined}
                  aria-label="Flag as rejected"
                  aria-pressed={photo?.flag === "reject"}
                  disabled={!photo}
                  onClick={() => onFlagChange("reject")}
                >
                  <X aria-hidden="true" size={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          </div>
        </LibraryPanel>

        <LibraryPanel title="Keywording" defaultOpen>
          <label className="library-inspector__stacked-field">
            <span>Enter Keywords</span>
            <textarea
              value={keywordDraft}
              rows={2}
              placeholder={photo ? "Separate keywords with commas" : "No photo selected"}
              disabled={!photo}
              onChange={(event) => setKeywordDraft(event.currentTarget.value)}
              onBlur={commitKeywords}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <div className="library-inspector__hint">
            Press Enter to apply to the selected photo.
          </div>
        </LibraryPanel>

        <LibraryPanel title="Keyword List" count={photo?.keywords.length ?? 0}>
          {photo?.keywords.length ? (
            <ul className="library-keyword-list">
              {photo.keywords.map((keyword) => (
                <li key={keyword}>
                  <span>{keyword}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${keyword}`}
                    onClick={() =>
                      onKeywordsChange(
                        photo.keywords.filter((item) => item !== keyword),
                      )
                    }
                  >
                    <X aria-hidden="true" size={11} strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="library-inspector__empty">No keywords assigned</div>
          )}
        </LibraryPanel>

        <LibraryPanel title="Metadata">
          <dl className="library-metadata">
            <MetadataRow label="File Name" value={photo?.name} />
            <MetadataRow label="File Type" value={photo?.type} />
            <MetadataRow label="File Size" value={photo && formatBytes(photo.size)} />
            <MetadataRow label="Dimensions" value={dimensions} />
            <MetadataRow label="Camera" value={photo?.metadata.camera} />
            <MetadataRow label="Lens" value={photo?.metadata.lens} />
            <MetadataRow
              label="Capture Time"
              value={formatDate(photo?.metadata.capturedAt)}
            />
          </dl>
          <label className="library-inspector__stacked-field">
            <span>Caption</span>
            <textarea
              value={captionDraft}
              rows={3}
              disabled={!photo}
              onChange={(event) => setCaptionDraft(event.currentTarget.value)}
              onBlur={commitCaption}
            />
          </label>
          <label className="library-inspector__stacked-field">
            <span>Copyright</span>
            <input
              type="text"
              value={copyrightDraft}
              disabled={!photo}
              onChange={(event) => setCopyrightDraft(event.currentTarget.value)}
              onBlur={commitCopyright}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        </LibraryPanel>

        <LibraryPanel title="Comments">
          <div className="library-comments-empty">
            <strong>No comments</strong>
            <span>Comments are available for synced photos.</span>
          </div>
        </LibraryPanel>
      </div>
    </aside>
  );
}
