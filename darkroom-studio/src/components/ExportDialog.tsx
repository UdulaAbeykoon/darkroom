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
    qualityPercent === 90;
  const instagramActive =
    settings.format === "image/jpeg" &&
    settings.resizeMode === "long-edge" &&
    settings.longEdge === 2048 &&
    qualityPercent === 85;
  const exampleName = `${settings.fileName.trim() || photo.name.replace(/\.[^.]+$/, "")}.${extension}`;

  const applyFullSizePreset = () => {
    onChange({
      ...settings,
      format: "image/jpeg",
      quality: 0.9,
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

  const applyInstagramPreset = () => {
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
          <div className="lrc-export-footer__preset-actions">
            <button type="button" className="button button--quiet" disabled>
              Add
            </button>
            <button type="button" className="button button--quiet" disabled>
              Remove
            </button>
          </div>
          <button
            type="button"
            className="button button--quiet lrc-export-footer__plugin"
            disabled
          >
            Plug-in Manager…
          </button>
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
          <div className="lrc-export-presets__title">Preset:</div>
          <div className="lrc-export-presets__list">
            <div className="lrc-export-presets__group">
              <div className="lrc-export-presets__group-title">
                <ChevronDown size={11} strokeWidth={2.3} aria-hidden="true" />
                <span>Darkroom Presets</span>
              </div>
              <button
                type="button"
                className={`lrc-export-preset ${fullSizeActive ? "is-active" : ""}`}
                aria-pressed={fullSizeActive}
                onClick={applyFullSizePreset}
              >
                Burn Full-Sized JPEGs
              </button>
              <button
                type="button"
                className="lrc-export-preset"
                disabled
                title="DNG export is not available in the browser renderer"
              >
                Export to DNG
              </button>
              <button
                type="button"
                className="lrc-export-preset"
                onClick={applyEmailPreset}
              >
                For Email (Hard Drive)
              </button>
              <button
                type="button"
                className="lrc-export-preset"
                onClick={applyEmailPreset}
              >
                For Email
              </button>
            </div>

            <div className="lrc-export-presets__group">
              <div className="lrc-export-presets__group-title">
                <ChevronDown size={11} strokeWidth={2.3} aria-hidden="true" />
                <span>User Presets</span>
              </div>
              <button
                type="button"
                className={`lrc-export-preset ${instagramActive ? "is-active" : ""}`}
                aria-pressed={instagramActive}
                onClick={applyInstagramPreset}
              >
                Instagram Export
              </button>
            </div>
          </div>
        </aside>

        <main className="lrc-export-settings">
          <div className="lrc-export-target">
            <label htmlFor="lrc-export-target">Export To:</label>
            <select
              id="lrc-export-target"
              disabled
              value="hard-drive"
              title="Files are saved through the browser download location"
            >
              <option value="hard-drive">Hard Drive</option>
            </select>
          </div>

          <div className="lrc-export-sections">
            <ExportSection title="Export Location" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-control">
                  <span>Export To:</span>
                  <select disabled value="specific-folder">
                    <option value="specific-folder">Specific folder</option>
                  </select>
                </label>
                <div className="lrc-export-control">
                  <span>Folder:</span>
                  <span className="lrc-export-destination">
                    <input type="text" disabled value="Downloads" readOnly />
                    <button type="button" disabled>
                      Choose…
                    </button>
                  </span>
                </div>
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Put in Subfolder:</span>
                  <input type="text" disabled aria-label="Subfolder name" />
                </label>
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Add to This Catalog</span>
                </label>
                <label className="lrc-export-control">
                  <span>Existing Files:</span>
                  <select disabled value="ask">
                    <option value="ask">Ask what to do</option>
                  </select>
                </label>
              </div>
            </ExportSection>

            <ExportSection title="File Naming" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-control">
                  <span>{selectionCount > 1 ? "Custom Text:" : "Rename To:"}</span>
                  <input
                    type="text"
                    value={settings.fileName}
                    placeholder={selectionCount > 1 ? "Darkroom_export" : "Untitled"}
                    onChange={(event) =>
                      onChange({ ...settings, fileName: event.target.value })
                    }
                  />
                </label>
                <label className="lrc-export-control">
                  <span>Extensions:</span>
                  <select disabled value="lowercase">
                    <option value="lowercase">Lowercase</option>
                  </select>
                </label>
                <p className="lrc-export-example">Example: {exampleName}</p>
              </div>
            </ExportSection>

            <ExportSection title="Video">
              <div className="lrc-export-form-grid">
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Include Video Files</span>
                </label>
                <label className="lrc-export-control">
                  <span>Video Format:</span>
                  <select disabled value="h264">
                    <option value="h264">H.264</option>
                  </select>
                </label>
                <label className="lrc-export-control">
                  <span>Quality:</span>
                  <select disabled value="high">
                    <option value="high">High</option>
                  </select>
                </label>
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
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/png">PNG</option>
                    <option value="image/webp">WebP</option>
                  </select>
                </label>
                <label
                  className={`lrc-export-control lrc-export-control--range ${
                    settings.format === "image/png" ? "is-disabled" : ""
                  }`}
                >
                  <span>Quality:</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={qualityPercent}
                    disabled={settings.format === "image/png"}
                    onChange={(event) =>
                      onChange({
                        ...settings,
                        quality: Number(event.target.value) / 100,
                      })
                    }
                  />
                  <output>
                    {settings.format === "image/png" ? "—" : qualityPercent}
                  </output>
                </label>
                <label className="lrc-export-control">
                  <span>Color Space:</span>
                  <select disabled value="srgb">
                    <option value="srgb">sRGB</option>
                  </select>
                </label>
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Limit File Size To:</span>
                  <span className="lrc-export-inline-number">
                    <input type="number" disabled value={100} readOnly />
                    <span>K</span>
                  </span>
                </label>
              </div>
            </ExportSection>

            <ExportSection title="Content Credentials (Early Access)">
              <label className="lrc-export-check lrc-export-check--flush">
                <input type="checkbox" disabled />
                <span>Attach Content Credentials</span>
              </label>
            </ExportSection>

            <ExportSection title="Image Sizing" defaultOpen>
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
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Don&apos;t Enlarge</span>
                </label>
                <label className="lrc-export-control">
                  <span>Resolution:</span>
                  <span className="lrc-export-number-unit">
                    <input type="number" disabled value={240} readOnly />
                    <span>pixels per inch</span>
                  </span>
                </label>
              </div>
            </ExportSection>

            <ExportSection title="Output Sharpening" defaultOpen>
              <div className="lrc-export-form-grid">
                <div className="lrc-export-resize-row">
                  <label className="lrc-export-check lrc-export-check--flush">
                    <input type="checkbox" disabled />
                    <span>Sharpen For:</span>
                  </label>
                  <select disabled value="screen" aria-label="Sharpening output">
                    <option value="screen">Screen</option>
                  </select>
                </div>
                <label className="lrc-export-control">
                  <span>Amount:</span>
                  <select disabled value="standard">
                    <option value="standard">Standard</option>
                  </select>
                </label>
              </div>
            </ExportSection>

            <ExportSection title="Metadata" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-control">
                  <span>Include:</span>
                  <select disabled value="all">
                    <option value="all">All Metadata</option>
                  </select>
                </label>
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Remove Person Info</span>
                </label>
                <label className="lrc-export-check">
                  <input type="checkbox" disabled />
                  <span>Remove Location Info</span>
                </label>
                <label className="lrc-export-check">
                  <input
                    type="checkbox"
                    checked={settings.includeMetadata}
                    disabled
                    readOnly
                  />
                  <span>Write Keywords as Hierarchy</span>
                </label>
              </div>
            </ExportSection>

            <ExportSection title="Watermarking" defaultOpen>
              <div className="lrc-export-form-grid">
                <div className="lrc-export-resize-row">
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
                    <span>Watermark:</span>
                  </label>
                  <select
                    value={settings.watermarkEnabled ? "custom" : "none"}
                    disabled={!settings.watermarkEnabled}
                    aria-label="Watermark preset"
                    onChange={() => undefined}
                  >
                    <option value="none">None</option>
                    <option value="custom">Custom Text</option>
                  </select>
                </div>
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
            </ExportSection>

            <ExportSection title="Post-Processing" defaultOpen>
              <div className="lrc-export-form-grid">
                <label className="lrc-export-control">
                  <span>After Export:</span>
                  <select disabled value="nothing">
                    <option value="nothing">Do nothing</option>
                  </select>
                </label>
              </div>
            </ExportSection>
          </div>
        </main>
      </div>
    </Modal>
  );
}
