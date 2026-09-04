import { useId } from "react";
import { Modal } from "./ui";
import "./SyncSettingsDialog.css";

export const SYNC_SETTINGS_CATEGORIES = [
  { key: "treatmentProfile", label: "Treatment & Profile" },
  { key: "whiteBalance", label: "White Balance" },
  { key: "basicTone", label: "Basic Tone" },
  { key: "toneCurve", label: "Tone Curve" },
  { key: "hslColor", label: "HSL / Color" },
  { key: "colorGrading", label: "Color Grading" },
  { key: "detail", label: "Detail" },
  { key: "lensCorrections", label: "Lens Corrections" },
  { key: "lensBlur", label: "Lens Blur" },
  { key: "transform", label: "Transform" },
  { key: "effects", label: "Effects" },
  { key: "calibration", label: "Calibration" },
  { key: "crop", label: "Crop" },
  { key: "remove", label: "Remove" },
  { key: "masks", label: "Masks" },
] as const;

export type SyncSettingsCategory =
  (typeof SYNC_SETTINGS_CATEGORIES)[number]["key"];

const RAW_SYNC_SETTINGS_DETAIL_GROUPS = {
  basicTone: [
    { key: "basicTone.exposure", label: "Exposure" },
    { key: "basicTone.contrast", label: "Contrast" },
    { key: "basicTone.highlights", label: "Highlights" },
    { key: "basicTone.shadows", label: "Shadows" },
    { key: "basicTone.whites", label: "Whites" },
    { key: "basicTone.blacks", label: "Blacks" },
    { key: "basicTone.texture", label: "Texture" },
    { key: "basicTone.clarity", label: "Clarity" },
    { key: "basicTone.dehaze", label: "Dehaze" },
    { key: "basicTone.vibrance", label: "Vibrance" },
    { key: "basicTone.saturation", label: "Saturation" },
  ],
  detail: [
    { key: "detail.sharpening", label: "Sharpening" },
    { key: "detail.noiseReduction", label: "Noise Reduction" },
    {
      key: "detail.colorNoiseReduction",
      label: "Color Noise Reduction",
    },
  ],
  lensCorrections: [
    {
      key: "lensCorrections.chromaticAberration",
      label: "Remove Chromatic Aberration",
    },
    {
      key: "lensCorrections.profile",
      label: "Profile Corrections",
    },
    { key: "lensCorrections.distortion", label: "Distortion" },
    { key: "lensCorrections.vignetting", label: "Lens Vignetting" },
    { key: "lensCorrections.defringe", label: "Defringe" },
  ],
  transform: [
    { key: "transform.upright", label: "Upright Mode" },
    { key: "transform.guides", label: "Guided Upright Lines" },
    { key: "transform.constrainCrop", label: "Constrain Crop" },
    { key: "transform.rotate", label: "Rotate" },
    { key: "transform.vertical", label: "Vertical" },
    { key: "transform.horizontal", label: "Horizontal" },
    { key: "transform.aspect", label: "Aspect" },
    { key: "transform.scale", label: "Scale" },
    { key: "transform.offsets", label: "X / Y Offset" },
    { key: "transform.flip", label: "Flip" },
  ],
  effects: [
    { key: "effects.vignette", label: "Post-Crop Vignetting" },
    { key: "effects.grain", label: "Grain" },
  ],
} as const;

export type SyncSettingsDetail =
  (typeof RAW_SYNC_SETTINGS_DETAIL_GROUPS)[keyof typeof RAW_SYNC_SETTINGS_DETAIL_GROUPS][number]["key"];

export interface SyncSettingsDetailDefinition {
  key: SyncSettingsDetail;
  label: string;
}

export const SYNC_SETTINGS_DETAIL_GROUPS: Partial<
  Record<SyncSettingsCategory, readonly SyncSettingsDetailDefinition[]>
> = RAW_SYNC_SETTINGS_DETAIL_GROUPS;

/**
 * `details` is optional so settings selections created by earlier builds
 * remain valid. When a detail is absent, its parent category controls it.
 */
export type SyncSettingsSelection = Record<SyncSettingsCategory, boolean> & {
  details?: Partial<Record<SyncSettingsDetail, boolean>>;
};

export type SyncSettingsSelectionChangeCallback = (
  selection: SyncSettingsSelection,
) => void;

export type SyncSettingsSynchronizeCallback = (
  selection: SyncSettingsSelection,
) => void;

export interface SyncSettingsDialogProps {
  selection: SyncSettingsSelection;
  onSelectionChange: SyncSettingsSelectionChangeCallback;
  onCancel: () => void;
  onSynchronize: SyncSettingsSynchronizeCallback;
  targetCount?: number;
  title?: string;
  instruction?: string;
  confirmLabel?: string;
}

export function createSyncSettingsSelection(
  checked = true,
): SyncSettingsSelection {
  const selection = {} as SyncSettingsSelection;
  SYNC_SETTINGS_CATEGORIES.forEach(({ key }) => {
    selection[key] = checked;
  });
  return selection;
}

export function isSyncSettingDetailSelected(
  selection: SyncSettingsSelection,
  category: SyncSettingsCategory,
  detail: SyncSettingsDetail,
): boolean {
  return selection.details?.[detail] ?? selection[category];
}

export const DEFAULT_SYNC_SETTINGS_SELECTION = createSyncSettingsSelection();

export default function SyncSettingsDialog({
  selection,
  onSelectionChange,
  onCancel,
  onSynchronize,
  targetCount,
  title = "Synchronize Settings",
  instruction,
  confirmLabel = "Synchronize",
}: SyncSettingsDialogProps) {
  const checklistId = useId();
  const detailValues = SYNC_SETTINGS_CATEGORIES.flatMap(({ key }) => {
    const details = SYNC_SETTINGS_DETAIL_GROUPS[key];
    return details?.length
      ? details.map(({ key: detail }) =>
          isSyncSettingDetailSelected(selection, key, detail),
        )
      : [selection[key]];
  });
  const selectedCount = detailValues.filter(Boolean).length;

  const setAll = (checked: boolean) => {
    onSelectionChange(createSyncSettingsSelection(checked));
  };

  const setCategory = (category: SyncSettingsCategory, checked: boolean) => {
    const details = { ...selection.details };
    SYNC_SETTINGS_DETAIL_GROUPS[category]?.forEach(({ key }) => {
      delete details[key];
    });
    onSelectionChange({
      ...selection,
      [category]: checked,
      ...(Object.keys(details).length ? { details } : { details: undefined }),
    });
  };

  const setDetail = (
    category: SyncSettingsCategory,
    detail: SyncSettingsDetail,
    checked: boolean,
  ) => {
    const definitions = SYNC_SETTINGS_DETAIL_GROUPS[category] ?? [];
    const details = { ...selection.details };
    definitions.forEach(({ key }) => {
      if (details[key] === undefined) {
        details[key] = selection[category];
      }
    });
    details[detail] = checked;
    onSelectionChange({
      ...selection,
      [category]: definitions.every(({ key }) => details[key]),
      details,
    });
  };

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <div className="sync-settings-dialog__bulk-actions">
            <button
              type="button"
              className="sync-settings-dialog__button"
              onClick={() => setAll(true)}
            >
              Check All
            </button>
            <button
              type="button"
              className="sync-settings-dialog__button"
              onClick={() => setAll(false)}
            >
              Check None
            </button>
          </div>
          <div className="sync-settings-dialog__confirm-actions">
            <button
              type="button"
              className="sync-settings-dialog__button"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="sync-settings-dialog__button sync-settings-dialog__button--primary"
              onClick={() => onSynchronize(selection)}
            >
              {confirmLabel}
            </button>
          </div>
        </>
      }
    >
      <div className="sync-settings-dialog">
        <p className="sync-settings-dialog__instruction" id={checklistId}>
          {instruction ?? (
            <>
              Select the settings to synchronize
              {targetCount === undefined
                ? "."
                : ` with ${targetCount} other selected ${targetCount === 1 ? "photo" : "photos"}.`}
            </>
          )}
        </p>

        <fieldset
          className="sync-settings-dialog__checklist"
          aria-describedby={checklistId}
        >
          <legend className="sync-settings-dialog__legend">
            Develop settings
          </legend>
          {SYNC_SETTINGS_CATEGORIES.map(({ key, label }) => {
            const details = SYNC_SETTINGS_DETAIL_GROUPS[key] ?? [];
            const values = details.map(({ key: detail }) =>
              isSyncSettingDetailSelected(selection, key, detail),
            );
            const allSelected = details.length
              ? values.every(Boolean)
              : selection[key];
            const partiallySelected =
              details.length > 0 && values.some(Boolean) && !allSelected;

            return (
              <div
                className="sync-settings-dialog__group"
                key={key}
                role={details.length ? "group" : undefined}
                aria-label={details.length ? label : undefined}
              >
                <label className="sync-settings-dialog__option sync-settings-dialog__option--parent">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(node) => {
                      if (node) node.indeterminate = partiallySelected;
                    }}
                    onChange={(event) =>
                      setCategory(key, event.target.checked)
                    }
                  />
                  <span
                    className="sync-settings-dialog__checkbox"
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </label>

                {details.length ? (
                  <div className="sync-settings-dialog__children">
                    {details.map(({ key: detail, label: detailLabel }) => (
                      <label
                        className="sync-settings-dialog__option sync-settings-dialog__option--child"
                        key={detail}
                      >
                        <input
                          type="checkbox"
                          checked={isSyncSettingDetailSelected(
                            selection,
                            key,
                            detail,
                          )}
                          onChange={(event) =>
                            setDetail(key, detail, event.target.checked)
                          }
                        />
                        <span
                          className="sync-settings-dialog__checkbox"
                          aria-hidden="true"
                        />
                        <span>{detailLabel}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </fieldset>

        <span
          className="sync-settings-dialog__selection-status"
          aria-live="polite"
        >
          {selectedCount} of {detailValues.length} controls selected
        </span>
      </div>
    </Modal>
  );
}
