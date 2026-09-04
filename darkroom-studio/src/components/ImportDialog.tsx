import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  FileImage,
  Files,
  FolderOpen,
  HardDrive,
  Import,
  MoveRight,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  Collection,
  ImportMethod,
  ImportOptions,
  PhotoRecord,
} from "../types";
import { isCameraRawFile } from "../lib/rawImage";
import { Modal } from "./ui";
import "./ImportDialog.css";

type ImportCandidate = {
  id: string;
  file: File;
  duplicate: boolean;
  validationError: string | null;
};

type ReviewFilter = "all" | "new" | "issues";

const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/x-bmp",
  "image/x-ms-bmp",
  "image/tiff",
  "image/tif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
const SUPPORTED_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "jfif",
  "png",
  "webp",
  "gif",
  "bmp",
  "dib",
  "tif",
  "tiff",
  "heic",
  "heif",
  "hif",
]);

function fileKey(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}`;
}

function readableBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function fileExtension(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension && extension !== file.name.toLowerCase()) return extension;
  return file.type.split("/")[1]?.toLowerCase() || "image";
}

function validationError(file: File): string | null {
  if (file.size <= 0) return "Empty file";
  if (file.size > MAX_IMPORT_BYTES) return "Over 256 MB limit";
  if (isCameraRawFile(file)) return null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = file.type.toLowerCase().split(";")[0].trim();
  if (!SUPPORTED_EXTENSIONS.has(extension) && !SUPPORTED_MIME_TYPES.has(mime)) {
    return "Unsupported format";
  }
  return null;
}

function ImportMethod({
  label,
  detail,
  icon: Icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  detail: string;
  icon: typeof Copy;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`lrc-import-method ${active ? "is-active" : ""}`}
      aria-pressed={active}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? `${label} is unavailable in a browser catalog` : detail}
    >
      <span className="lrc-import-method__icon">
        <Icon size={18} strokeWidth={1.55} aria-hidden="true" />
      </span>
      <span>
        <strong>{label}</strong>
        <small>{disabled ? "Unavailable" : detail}</small>
      </span>
    </button>
  );
}

function SettingsPanel({
  title,
  children,
  open = false,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="lrc-import-panel" open={open}>
      <summary>
        <ChevronDown size={13} strokeWidth={1.8} aria-hidden="true" />
        <span>{title}</span>
      </summary>
      <div className="lrc-import-panel__body">{children}</div>
    </details>
  );
}

export default function ImportDialog({
  files,
  photos,
  collections,
  importing,
  onClose,
  onImport,
}: {
  files: File[];
  photos: PhotoRecord[];
  collections: Collection[];
  importing: boolean;
  onClose: () => void;
  onImport: (files: File[], options: ImportOptions) => void;
}) {
  const candidates = useMemo<ImportCandidate[]>(() => {
    const seen = new Set(
      photos.map((photo) => `${photo.name.toLowerCase()}-${photo.size}`),
    );
    return files.map((file, index) => {
      const comparisonKey = `${file.name.toLowerCase()}-${file.size}`;
      const duplicate = seen.has(comparisonKey);
      seen.add(comparisonKey);
      return {
        id: fileKey(file, index),
        file,
        duplicate,
        validationError: validationError(file),
      };
    });
  }, [files, photos]);
  const [included, setIncluded] = useState(
    () =>
      new Set(
        candidates
          .filter(
            (candidate) =>
              !candidate.duplicate && candidate.validationError === null,
          )
          .map((candidate) => candidate.id),
      ),
  );
  const [collectionId, setCollectionId] = useState("");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [importMethod, setImportMethod] = useState<ImportMethod>("add");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [keywords, setKeywords] = useState("");
  const [previewUrls, setPreviewUrls] = useState<Map<string, string>>(new Map());
  const [previewErrors, setPreviewErrors] = useState<Set<string>>(new Set());

  useEffect(() => {
    const urls = new Map<string, string>();
    candidates.forEach((candidate) => {
      if (!isCameraRawFile(candidate.file)) {
        urls.set(candidate.id, URL.createObjectURL(candidate.file));
      }
    });
    setPreviewUrls(urls);
    setPreviewErrors(new Set());
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [candidates]);

  const selected = candidates.filter(
    (candidate) =>
      included.has(candidate.id) &&
      candidate.validationError === null &&
      (!skipDuplicates || !candidate.duplicate),
  );
  const totalBytes = selected.reduce(
    (total, candidate) => total + candidate.file.size,
    0,
  );
  const issueCount = candidates.filter(
    (candidate) =>
      candidate.duplicate ||
      Boolean(candidate.validationError) ||
      previewErrors.has(candidate.id),
  ).length;
  const visibleCandidates = candidates.filter((candidate) => {
    if (reviewFilter === "new") {
      return (
        !candidate.duplicate &&
        !candidate.validationError &&
        !previewErrors.has(candidate.id)
      );
    }
    if (reviewFilter === "issues") {
      return (
        candidate.duplicate ||
        Boolean(candidate.validationError) ||
        previewErrors.has(candidate.id)
      );
    }
    return true;
  });

  const setAllIncluded = (checked: boolean) => {
    setIncluded(
      checked
        ? new Set(
            candidates
              .filter(
                (candidate) =>
                  candidate.validationError === null &&
                  (!skipDuplicates || !candidate.duplicate),
              )
              .map((candidate) => candidate.id),
          )
        : new Set(),
    );
  };

  const changeDuplicateHandling = (checked: boolean) => {
    setSkipDuplicates(checked);
    if (!checked) return;

    const duplicateIds = new Set(
      candidates
        .filter((candidate) => candidate.duplicate)
        .map((candidate) => candidate.id),
    );
    setIncluded(
      (current) =>
        new Set([...current].filter((candidateId) => !duplicateIds.has(candidateId))),
    );
  };

  return (
    <Modal
      title="Import Photos"
      description="Choose a source, select an import method, and review the photos to add to the catalog."
      size="large"
      onClose={onClose}
      footer={
        <>
          <div className="lrc-import-footer__local">
            <ShieldCheck size={14} aria-hidden="true" />
            <span>
              <strong>Local catalog</strong>
              <small>
                {importMethod === "add"
                  ? "Source remains in place"
                  : "Managed copy; source untouched"}
              </small>
            </span>
          </div>
          <div className="lrc-import-footer__selection" aria-live="polite">
            <strong>{selected.length} selected</strong>
            <span>of {candidates.length} · {readableBytes(totalBytes)}</span>
          </div>
          <button
            type="button"
            className="button button--quiet"
            disabled={importing}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary lrc-import-footer__import"
            disabled={importing || !selected.length}
            onClick={() =>
              onImport(
                selected.map((candidate) => candidate.file),
                {
                  method: importMethod,
                  duplicateHandling: skipDuplicates ? "skip" : "include",
                  keywords: keywords.split(","),
                  collectionId: collectionId || null,
                },
              )
            }
          >
            <Import size={15} aria-hidden="true" />
            {importing ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <div className="lrc-import-workspace">
        <aside className="lrc-import-source" aria-label="Import source">
          <div className="lrc-import-rail__title">Source</div>
          <div className="lrc-import-source__device">
            <HardDrive size={15} strokeWidth={1.6} aria-hidden="true" />
            <span>
              <strong>This computer</strong>
              <small>Browser-selected files</small>
            </span>
          </div>
          <div className="lrc-import-source__tree" role="tree">
            <button
              type="button"
              className="is-active"
              role="treeitem"
              aria-selected="true"
            >
              <FolderOpen size={14} strokeWidth={1.6} aria-hidden="true" />
              <span>Selected source</span>
              <small>{candidates.length}</small>
            </button>
          </div>
          <div className="lrc-import-source__summary">
            <Files size={15} aria-hidden="true" />
            <span>
              <strong>{candidates.length} files</strong>
              <small>{readableBytes(files.reduce((sum, file) => sum + file.size, 0))}</small>
            </span>
          </div>
          <p className="lrc-import-source__note">
            Browser security hides the full disk and folder tree. Use Folder from the
            main toolbar to choose another source.
          </p>
        </aside>

        <section className="lrc-import-main">
          <div className="lrc-import-methods" aria-label="Import method">
            <span className="lrc-import-methods__prompt">Import method</span>
            <div className="lrc-import-methods__choices">
              <ImportMethod
                label="Copy as DNG"
                detail="Convert and copy"
                icon={FileImage}
                disabled
              />
              <ImportMethod
                label="Copy"
                detail="Make managed copy"
                icon={Copy}
                active={importMethod === "copy"}
                onClick={() => setImportMethod("copy")}
              />
              <ImportMethod
                label="Move"
                detail="Move to destination"
                icon={MoveRight}
                disabled
              />
              <ImportMethod
                label="Add"
                detail="Keep source in place"
                icon={Plus}
                active={importMethod === "add"}
                onClick={() => setImportMethod("add")}
              />
            </div>
            <p>
              {importMethod === "add"
                ? "Add records the selected source directly without a separate pre-import copy. Browser storage still retains a private working copy so edits survive reloads."
                : "Copy creates a separate catalog-managed image blob. The selected source file is never moved or modified."}
            </p>
          </div>

          <div className="lrc-import-reviewbar">
            <div className="lrc-import-reviewbar__filters" role="group" aria-label="Review filter">
              {(
                [
                  ["all", "All Photos", candidates.length],
                  ["new", "New Photos", candidates.length - issueCount],
                  ["issues", "Issues", issueCount],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  type="button"
                  key={value}
                  className={reviewFilter === value ? "is-active" : ""}
                  aria-pressed={reviewFilter === value}
                  onClick={() => setReviewFilter(value)}
                >
                  {label} <span>{count}</span>
                </button>
              ))}
            </div>
            <div className="lrc-import-reviewbar__checks">
              <button type="button" onClick={() => setAllIncluded(true)}>
                Check All
              </button>
              <button type="button" onClick={() => setAllIncluded(false)}>
                Uncheck All
              </button>
            </div>
          </div>

          <div className="lrc-import-contact-sheet" role="list" aria-label="Photos to import">
            {visibleCandidates.map((candidate) => {
              const cameraRaw = isCameraRawFile(candidate.file);
              const disabled =
                Boolean(candidate.validationError) ||
                (candidate.duplicate && skipDuplicates);
              const checked = !disabled && included.has(candidate.id);
              const previewError = previewErrors.has(candidate.id);
              const issue =
                candidate.validationError ??
                (previewError ? "Preview unavailable" : null);
              return (
                <label
                  key={candidate.id}
                  className={[
                    "lrc-import-thumbnail",
                    checked ? "is-checked" : "",
                    candidate.duplicate ? "is-duplicate" : "",
                    issue ? "has-error" : "",
                    disabled ? "is-disabled" : "",
                  ].join(" ")}
                  role="listitem"
                >
                  <span className="lrc-import-thumbnail__image">
                    {previewUrls.get(candidate.id) && !previewError ? (
                      <img
                        src={previewUrls.get(candidate.id)}
                        alt=""
                        draggable={false}
                        onError={() =>
                          setPreviewErrors((current) => {
                            const next = new Set(current);
                            next.add(candidate.id);
                            return next;
                          })
                        }
                      />
                    ) : (
                      <FileImage size={30} strokeWidth={1.2} aria-hidden="true" />
                    )}
                    <span className="lrc-import-thumbnail__check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        aria-label={`Import ${candidate.file.name}`}
                        onChange={(event) => {
                          setIncluded((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(candidate.id);
                            else next.delete(candidate.id);
                            return next;
                          });
                        }}
                      />
                      <span aria-hidden="true">
                        {checked ? <Check size={12} strokeWidth={3} /> : null}
                      </span>
                    </span>
                    <span className="lrc-import-thumbnail__format">
                      {fileExtension(candidate.file).toUpperCase()}
                    </span>
                  </span>
                  <span className="lrc-import-thumbnail__caption">
                    <strong title={candidate.file.name}>{candidate.file.name}</strong>
                    <small>{readableBytes(candidate.file.size)}</small>
                  </span>
                  {candidate.duplicate || issue ? (
                    <span className="lrc-import-thumbnail__status">
                      <AlertTriangle size={11} aria-hidden="true" />
                      {issue ?? "Suspected duplicate"}
                    </span>
                  ) : (
                    <span className="lrc-import-thumbnail__status is-ready">
                      <Check size={11} aria-hidden="true" />
                      {cameraRaw ? "RAW · Ready to decode" : "Ready to import"}
                    </span>
                  )}
                </label>
              );
            })}
            {!visibleCandidates.length ? (
              <div className="lrc-import-contact-sheet__empty">
                <FileImage size={28} strokeWidth={1.2} aria-hidden="true" />
                <strong>No photos in this view</strong>
                <span>Choose another review filter to see the remaining files.</span>
              </div>
            ) : null}
          </div>
        </section>

        <aside className="lrc-import-settings" aria-label="Import settings">
          <SettingsPanel title="File Handling" open>
            <label className="lrc-import-field">
              <span>Build Previews</span>
              <select value="browser" disabled>
                <option value="browser">Browser standard</option>
              </select>
              <small>Preview size is optimized automatically.</small>
            </label>
            <label className="lrc-import-check-row">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(event) =>
                  changeDuplicateHandling(event.target.checked)
                }
              />
              <span>
                <strong>Don’t Import Suspected Duplicates</strong>
                <small>Verified with SHA-256 during import</small>
              </span>
            </label>
            <label className="lrc-import-check-row is-unavailable">
              <input type="checkbox" disabled />
              <span>
                <strong>Make a Second Copy To</strong>
                <small>Requires direct folder write access</small>
              </span>
            </label>
          </SettingsPanel>

          <SettingsPanel title="File Renaming">
            <label className="lrc-import-check-row is-unavailable">
              <input type="checkbox" disabled />
              <span>
                <strong>Rename Files</strong>
                <small>Original filenames are preserved</small>
              </span>
            </label>
            <label className="lrc-import-field is-unavailable">
              <span>Template</span>
              <select value="filename" disabled>
                <option value="filename">Filename</option>
              </select>
            </label>
          </SettingsPanel>

          <SettingsPanel title="Apply During Import">
            <label className="lrc-import-field is-unavailable">
              <span>Develop Settings</span>
              <select value="none" disabled>
                <option value="none">None</option>
              </select>
            </label>
            <label className="lrc-import-field is-unavailable">
              <span>Metadata</span>
              <select value="none" disabled>
                <option value="none">None</option>
              </select>
            </label>
            <label className="lrc-import-field">
              <span>Keywords</span>
              <input
                type="text"
                value={keywords}
                placeholder="Separate keywords with commas"
                onChange={(event) => setKeywords(event.target.value)}
              />
              <small>Applied to every imported photo.</small>
            </label>
            <p className="lrc-import-panel__notice">
              Develop settings and metadata presets can be applied after import.
            </p>
          </SettingsPanel>

          <SettingsPanel title="Destination" open>
            <div className="lrc-import-destination">
              <HardDrive size={15} aria-hidden="true" />
              <span>
                <strong>Local catalog</strong>
                <small>Private browser storage</small>
              </span>
            </div>
            <label className="lrc-import-field">
              <span>Add to Album</span>
              <select
                value={collectionId}
                onChange={(event) => setCollectionId(event.target.value)}
              >
                <option value="">No album</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="lrc-import-panel__notice">
              {importMethod === "add"
                ? "The source stays in place. A private persisted working copy keeps this browser catalog available after reload."
                : "A separate catalog-managed copy is stored in this browser profile. The selected source is untouched."}
            </p>
          </SettingsPanel>
        </aside>
      </div>
    </Modal>
  );
}
