import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import type { ExportSettings, PhotoRecord } from "../types";
import { Modal } from "./ui";

type ExportDialogProps = {
  photo: PhotoRecord;
  settings: ExportSettings;
  exporting: boolean;
  selectionCount: number;
  progress: { current: number; total: number; name: string } | null;
  onChange: (settings: ExportSettings) => void;
  onClose: () => void;
  onExport: () => void;
};

function ExportSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="lrc-export-section" open={defaultOpen}>
      <summary>
        <ChevronDown size={12} strokeWidth={2.4} aria-hidden="true" />
        <span>{title}</span>
      </summary>
      <div className="lrc-export-section__body">{children}</div>
    </details>
  );
}

export default function ExportDialog({
  photo,
  settings,
  exporting,
  selectionCount,
  progress,
  onChange,
  onClose,
  onExport,
}: ExportDialogProps) {
  const original = settings.format === "original";
  const lossless = original || settings.format === "image/png";
  const extension =
    settings.format === "image/png"
      ? "png"
      : settings.format === "image/webp"
        ? "webp"
        : "jpg";
  const qualityPercent = Math.round(
    Math.min(
      1,
      Math.max(
        0.1,
        settings.quality > 1 ? settings.quality / 100 : settings.quality,
      ),
    ) * 100,
  );
  const watermarkOpacityPercent = Math.round(
    Math.min(1, Math.max(0.1, settings.watermarkOpacity)) * 100,
  );
  const fullSizeActive =
    settings.format === "image/jpeg" &&
    settings.resizeMode === "original" &&
    qualityPercent === 100;
  const losslessPresetActive = settings.format === "image/png" && settings.resizeMode === "original";
  const webPresetActive =
    settings.format === "image/jpeg" &&
    settings.resizeMode === "long-edge" &&
    settings.longEdge === 2048 &&
    qualityPercent === 85;
  const emailActive =
    settings.format === "image/jpeg" &&
    settings.resizeMode === "long-edge" &&
    settings.longEdge === 1024 &&
    qualityPercent === 60;
  const photoBaseName = photo.name.replace(/\.[^/.]+$/, "");
  const exampleName = original ? photo.name : selectionCount > 1
    ? `${settings.fileName || "Darkroom_export"}_001_${photoBaseName}.${extension}`
    : `${settings.fileName || `${photoBaseName}_edit`}.${extension}`;

  const applyFullSizePreset = () => {
    onChange({
      ...settings,
      format: "image/jpeg",
      quality: 1,
      resizeMode: "original",
    });
  };

  const applyEmailPreset = () => {
    onChange({
      ...settings,
      format: "image/jpeg",
      quality: 0.6,
      resizeMode: "long-edge",
      longEdge: 1024,
    });
  };

  const applyWebPreset = () => {
    onChange({
      ...settings,
      format: "image/jpeg",
      quality: 0.85,
      resizeMode: "long-edge",
      longEdge: 2048,
    });
  };

  return (
    <Modal
      title={selectionCount > 1 ? `Export ${selectionCount} Files` : "Export One File"}
      onClose={onClose}
      size="large"
      footer={
        <>
          {progress ? (
            <div className="lrc-export-footer__status" role="status" aria-live="polite">
              <span className="lrc-export-footer__progress-track" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(
                        0,
                        (progress.current / Math.max(1, progress.total)) * 100,
                      ),
                    )}%`,
                  }}
                />
              </span>
              <span>
                Exporting {progress.current} of {progress.total}: {progress.name}
              </span>
            </div>
          ) : null}
          <span className="lrc-export-footer__spacer" aria-hidden="true" />
          <button
            type="button"
            className="button button--quiet lrc-export-footer__cancel"
            onClick={onClose}
          >
            {exporting ? "Cancel Export" : "Cancel"}
          </button>
          <button
            type="button"
            className="button button--primary lrc-export-footer__export"
            disabled={exporting}
            onClick={onExport}
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
        </>
      }
    >
      <div className="lrc-export-workspace">
        <aside className="lrc-export-presets" aria-label="Export presets">
          <div className="lrc-export-presets__title">Presets</div>
          <div className="lrc-export-presets__list">
            <button
              type="button"
              className={`lrc-export-preset ${losslessPresetActive ? "is-active" : ""}`}
              aria-pressed={losslessPresetActive}
              onClick={() => onChange({ ...settings, format: "image/png", quality: 1, resizeMode: "original" })}
            >Full-size PNG</button>
            <button
              type="button"
              className={`lrc-export-preset ${fullSizeActive ? "is-active" : ""}`}
              aria-pressed={fullSizeActive}
              onClick={applyFullSizePreset}
            >
              Full-size JPEG
            </button>
            <button
              type="button"
              className={`lrc-export-preset ${original ? "is-active" : ""}`}
              aria-pressed={original}
              onClick={() => onChange({ ...settings, format: "original" })}
            >Original file</button>
            <button
              type="button"
              className={`lrc-export-preset ${emailActive ? "is-active" : ""}`}
              aria-pressed={emailActive}
              onClick={applyEmailPreset}
            >
              Email JPEG
            </button>
            <button
              type="button"
              className={`lrc-export-preset ${webPresetActive ? "is-active" : ""}`}
              aria-pressed={webPresetActive}
              onClick={applyWebPreset}
            >
              2048 px JPEG
            </button>
          </div>
        </aside>

        <main className="lrc-export-settings">
          <div className="lrc-export-target">
            <p className="lrc-export-note">
              Files are saved using your browser’s download settings.
            </p>
          </div>

          <div className="lrc-export-sections">
            <ExportSection title="File Naming" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-control">
                  <span>{selectionCount > 1 ? "Custom Text:" : "Rename To:"}</span>
                  <input
                    type="text"
                    value={settings.fileName}
                    disabled={original}
                    placeholder={selectionCount > 1 ? "Darkroom_export" : "Untitled"}
                    onChange={(event) =>
                      onChange({ ...settings, fileName: event.target.value })
                    }
                  />
                </label>
                <p className="lrc-export-example">Example: {exampleName}</p>
              </div>
            </ExportSection>

            <ExportSection title="File Settings" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-control">
                  <span>Image Format:</span>
                  <select
                    value={settings.format}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        format: event.target.value as ExportSettings["format"],
                      })
                    }
                  >
                    <option value="original">Original file</option>
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/png">PNG</option>
                    <option value="image/webp">WebP</option>
                  </select>
                </label>
                <label
                  className={`lrc-export-control lrc-export-control--range ${
                    lossless ? "is-disabled" : ""
                  }`}
                >
                  <span>Quality:</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={qualityPercent}
                    disabled={lossless}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        quality: Number(event.target.value) / 100,
                      })
                    }
                  />
                  <output>
                    {lossless ? "—" : qualityPercent}
                  </output>
                </label>
                <p className="lrc-export-note">
                  {original
                    ? "Downloads the exact imported file, including its original name and metadata. Edits, resizing, and watermarks are not applied."
                    : settings.format === "image/png"
                      ? "PNG preserves the rendered pixels without lossy compression. Edited exports use 8-bit sRGB; original metadata is not included."
                      : "JPEG and WebP use lossy compression, even at quality 100. Edited exports use 8-bit sRGB; original metadata is not included."}
                </p>
                {!original && photo.renderKind === "camera-jpeg" ? (
                  <p className="lrc-export-note" role="status">This RAW compression only supports a camera preview. Choose Original file to preserve the full RAW quality.</p>
                ) : null}
              </div>
            </ExportSection>

            {!original ? <><ExportSection title="Image Sizing" defaultOpen>
              <div className="lrc-export-form-grid">
                <div className="lrc-export-resize-row">
                  <label className="lrc-export-check lrc-export-check--flush">
                    <input
                      type="checkbox"
                      checked={settings.resizeMode !== "original"}
                      onChange={(event) =>
                        onChange({
                          ...settings,
                          resizeMode: event.target.checked ? "long-edge" : "original",
                        })
                      }
                    />
                    <span>Resize to Fit:</span>
                  </label>
                  <select
                    value={
                      settings.resizeMode === "dimensions"
                        ? "dimensions"
                        : "long-edge"
                    }
                    disabled={settings.resizeMode === "original"}
                    aria-label="Resize method"
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        resizeMode: event.target.value as "long-edge" | "dimensions",
                      })
                    }
                  >
                    <option value="long-edge">Long Edge</option>
                    <option value="dimensions">Width &amp; Height</option>
                  </select>
                </div>
                {settings.resizeMode === "long-edge" ? (
                  <label className="lrc-export-control">
                    <span>Long Edge:</span>
                    <span className="lrc-export-number-unit">
                      <input
                        type="number"
                        min={320}
                        max={32000}
                        value={settings.longEdge}
                        onChange={(event) =>
                          onChange({
                            ...settings,
                            longEdge: Number(event.target.value),
                          })
                        }
                      />
                      <span>pixels</span>
                    </span>
                  </label>
                ) : null}
                {settings.resizeMode === "dimensions" ? (
                  <div className="lrc-export-dimension-row">
                    <label>
                      <span>W:</span>
                      <input
                        type="number"
                        min={1}
                        max={32000}
                        value={settings.width}
                        onChange={(event) =>
                          onChange({ ...settings, width: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label>
                      <span>H:</span>
                      <input
                        type="number"
                        min={1}
                        max={32000}
                        value={settings.height}
                        onChange={(event) =>
                          onChange({ ...settings, height: Number(event.target.value) })
                        }
                      />
                    </label>
                    <span>pixels</span>
                  </div>
                ) : null}
              </div>
            </ExportSection>

            <ExportSection title="Watermarking" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-check lrc-export-check--flush">
                  <input
                    type="checkbox"
                    checked={settings.watermarkEnabled}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        watermarkEnabled: event.target.checked,
                      })
                    }
                  />
                  <span>Add a text watermark</span>
                </label>
                <label className="lrc-export-control">
                  <span>Text:</span>
                  <input
                    type="text"
                    value={settings.watermarkText}
                    disabled={!settings.watermarkEnabled}
                    placeholder="Your name or copyright"
                    onChange={(event) =>
                      onChange({ ...settings, watermarkText: event.target.value })
                    }
                  />
                </label>
                <label className="lrc-export-control">
                  <span>Position:</span>
                  <select
                    value={settings.watermarkPosition}
                    disabled={!settings.watermarkEnabled}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        watermarkPosition: event.target
                          .value as ExportSettings["watermarkPosition"],
                      })
                    }
                  >
                    <option value="top-left">Top Left</option>
                    <option value="top-right">Top Right</option>
                    <option value="center">Center</option>
                    <option value="bottom-left">Bottom Left</option>
                    <option value="bottom-right">Bottom Right</option>
                  </select>
                </label>
                <label
                  className={`lrc-export-control lrc-export-control--range ${
                    settings.watermarkEnabled ? "" : "is-disabled"
                  }`}
                >
                  <span>Opacity:</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={watermarkOpacityPercent}
                    disabled={!settings.watermarkEnabled}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        watermarkOpacity: Number(event.target.value) / 100,
                      })
                    }
                  />
                  <output>{watermarkOpacityPercent}</output>
                </label>
              </div>
            </ExportSection></> : null}
          </div>
        </main>
      </div>
    </Modal>
  );
}
