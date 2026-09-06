import { type ReactNode, useState } from "react";
import {
  Aperture,
  Bandage,
  Blend,
  Brush,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDotDashed,
  CloudSun,
  Copy,
  Crop,
  Focus,
  Gauge,
  History,
  Info,
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  SunMedium,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  BUILT_IN_PRESETS,
  canonicalProfileName,
  DEFAULT_GLOBAL_ADJUSTMENTS,
  HUE_CHANNELS,
} from "../defaults";
import {
  getMaskComponents,
  legacyRegionForPeopleFeatures,
  normalizePeopleFeatures,
  PEOPLE_FEATURE_LABELS,
  PEOPLE_FEATURES,
} from "../lib/maskMath";
import type {
  BrushStroke,
  CalibrationAdjustments,
  ColorGrading,
  ColorLabel,
  CropOverlay,
  CropState,
  DevelopPreset,
  EditState,
  EditSnapshot,
  GeometryAdjustments,
  GlobalAdjustments,
  HealSpot,
  HistogramData,
  HslChannel,
  HueChannel,
  LensBlurAdjustments,
  LensCorrections,
  LocalAdjustments,
  Mask,
  MaskComponent,
  MaskKind,
  PeopleFeature,
  PhotoMetadata,
  PhotoRecord,
  PointColorAdjustments,
  ToneCurvePoint,
  UprightGuide,
} from "../types";
import CalibrationPanel from "./CalibrationPanel";
import ColorGradingWheel from "./ColorGradingWheel";
import CurveEditor from "./CurveEditor";
import Histogram from "./Histogram";
import LensBlurPanel from "./LensBlurPanel";
import { LensCorrectionsPanel } from "./LensCorrectionsPanel";
import { AdjustmentSlider, IconButton, Panel, SegmentedControl } from "./ui";

export type EditorTool =
  | "edit"
  | "presets"
  | "crop"
  | "heal"
  | "mask"
  | "versions"
  | "metadata";
export type HealToolSettings = {
  size: number;
  feather: number;
  opacity: number;
  mode: "remove" | "clone" | "heal";
};
export type HealOverlayMode = "auto" | "always" | "selected" | "never";
export type MaskBrushSettings = {
  size: number;
  feather: number;
  flow: number;
  density: number;
  autoMask: boolean;
  erase: boolean;
};

export type MaskOverlayMode =
  | "color"
  | "color-on-black"
  | "color-on-white"
  | "white-on-black"
  | "black-on-white";

type InspectorProps = {
  photo: PhotoRecord;
  histogram: HistogramData | null;
  tool: EditorTool;
  activeMaskId: string | null;
  activeMaskComponentId: string | null;
  healSettings: HealToolSettings;
  activeHealSpotId: string | null;
  healOverlayMode: HealOverlayMode;
  visualizeSpots: boolean;
  visualizeSpotsThreshold: number;
  maskBrushSettings: MaskBrushSettings;
  overlayMode: MaskOverlayMode;
  overlayOpacity: number;
  showClipping: boolean;
  snapshots: EditSnapshot[];
  historyCount: number;
  cropOverlay: CropOverlay;
  onToolChange: (tool: EditorTool) => void;
  onCropOverlayChange: (overlay: CropOverlay) => void;
  onToggleClipping: () => void;
  onProfileChange: (profile: string) => void;
  onAutoAdjust: () => void;
  onApplyPreset: (preset: DevelopPreset) => void;
  onPreviewPreset?: (preset: DevelopPreset | null) => void;
  onCreateSnapshot: () => void;
  onRestoreSnapshot: (snapshot: EditSnapshot) => void;
  onResetEdits: () => void;
  onBeginEdit: () => void;
  onCommitEdit: () => void;
  onGlobalChange: <K extends keyof GlobalAdjustments>(
    key: K,
    value: GlobalAdjustments[K],
  ) => void;
  onCurveChange: (points: ToneCurvePoint[]) => void;
  onColorCurveChange: (
    channel: "red" | "green" | "blue",
    points: ToneCurvePoint[],
  ) => void;
  onHslChange: (channel: HueChannel, value: HslChannel) => void;
  onPointColorChange: (pointColor: PointColorAdjustments) => void;
  onColorGradingChange: (grading: ColorGrading) => void;
  onLensCorrectionsChange: (lensCorrections: LensCorrections) => void;
  onLensBlurChange: (lensBlur: LensBlurAdjustments) => void;
  onCalibrationChange: (calibration: CalibrationAdjustments) => void;
  onGeometryChange: <K extends keyof GeometryAdjustments>(
    key: K,
    value: GeometryAdjustments[K],
  ) => void;
  onUprightModeChange: (
    mode: GeometryAdjustments["uprightMode"],
    refresh?: boolean,
  ) => void;
  onUprightGuidesChange: (guides: UprightGuide[]) => void;
  onCropChange: (crop: CropState) => void;
  onCreateMask: (kind: MaskKind) => void;
  onCreatePeopleMasks: (features: PeopleFeature[], separate: boolean) => void;
  onSelectMask: (id: string) => void;
  onSelectMaskComponent: (groupId: string, componentId: string) => void;
  onAddMaskComponent: (
    groupId: string,
    kind: MaskKind,
    operation: MaskComponent["operation"],
  ) => void;
  onUpdateMask: (id: string, patch: Partial<Mask>) => void;
  onUpdateMaskComponent: (
    groupId: string,
    componentId: string,
    patch: Partial<MaskComponent>,
  ) => void;
  onUpdateMaskAdjustments: (id: string, patch: Partial<LocalAdjustments>) => void;
  onDeleteMask: (id: string) => void;
  onDeleteMaskComponent: (groupId: string, componentId: string) => void;
  onDuplicateMask: (id: string, invert?: boolean) => void;
  onRenameMask: (id: string, name: string) => void;
  onAppendBrushStroke: (maskId: string, stroke: BrushStroke) => void;
  onRemoveHealSpot: (id: string) => void;
  onUpdateHealSpot: (id: string, patch: Partial<HealSpot>) => void;
  onRecenterHealSource: (id: string) => void;
  onActiveHealSpotChange: (id: string | null) => void;
  onHealOverlayModeChange: (mode: HealOverlayMode) => void;
  onVisualizeSpotsChange: (visible: boolean) => void;
  onVisualizeSpotsThresholdChange: (threshold: number) => void;
  onResetHealSpots: () => void;
  onCloseHeal: () => void;
  onHealSettingsChange: (settings: HealToolSettings) => void;
  onMaskBrushSettingsChange: (settings: MaskBrushSettings) => void;
  onOverlayModeChange: (mode: MaskOverlayMode) => void;
  onOverlayOpacityChange: (opacity: number) => void;
  onResetSection: (keys: (keyof GlobalAdjustments)[]) => void;
  onPreviousSettings: () => void;
  onSyncSettings: () => void;
  syncCount: number;
  onMetadataChange: (patch: Partial<PhotoMetadata>) => void;
  onKeywordsChange: (keywords: string[]) => void;
  onColorLabelChange: (label: ColorLabel) => void;
};

const GLOBAL_SECTIONS: {
  title: string;
  open?: boolean;
  controls: {
    key: keyof GlobalAdjustments;
    label: string;
    min: number;
    max: number;
    step?: number;
  }[];
}[] = [
  {
    title: "Light",
    open: true,
    controls: [
      { key: "exposure", label: "Exposure", min: -5, max: 5, step: 0.01 },
      { key: "contrast", label: "Contrast", min: -100, max: 100 },
      { key: "highlights", label: "Highlights", min: -100, max: 100 },
      { key: "shadows", label: "Shadows", min: -100, max: 100 },
      { key: "whites", label: "Whites", min: -100, max: 100 },
      { key: "blacks", label: "Blacks", min: -100, max: 100 },
    ],
  },
  {
    title: "Color",
    open: true,
    controls: [
      { key: "temperature", label: "Temperature", min: -100, max: 100 },
      { key: "tint", label: "Tint", min: -100, max: 100 },
      { key: "vibrance", label: "Vibrance", min: -100, max: 100 },
      { key: "saturation", label: "Saturation", min: -100, max: 100 },
    ],
  },
  {
    title: "Effects",
    controls: [
      { key: "texture", label: "Texture", min: -100, max: 100 },
      { key: "clarity", label: "Clarity", min: -100, max: 100 },
      { key: "dehaze", label: "Dehaze", min: -100, max: 100 },
      { key: "vignette", label: "Vignette", min: -100, max: 100 },
      { key: "vignetteMidpoint", label: "Midpoint", min: 0, max: 100 },
      { key: "vignetteFeather", label: "Feather", min: 0, max: 100 },
      { key: "grain", label: "Grain", min: 0, max: 100 },
      { key: "grainSize", label: "Grain size", min: 1, max: 100 },
    ],
  },
  {
    title: "Detail",
    controls: [
      { key: "sharpening", label: "Sharpening", min: 0, max: 100 },
      { key: "noiseReduction", label: "Luminance NR", min: 0, max: 100 },
      { key: "colorNoiseReduction", label: "Color NR", min: 0, max: 100 },
    ],
  },
];

const LOCAL_CONTROLS: {
  key: keyof LocalAdjustments;
  label: string;
  min: number;
  max: number;
  step?: number;
}[] = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.01 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "whites", label: "Whites", min: -100, max: 100 },
  { key: "blacks", label: "Blacks", min: -100, max: 100 },
  { key: "temperature", label: "Temperature", min: -100, max: 100 },
  { key: "tint", label: "Tint", min: -100, max: 100 },
  { key: "hue", label: "Hue", min: -180, max: 180 },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "texture", label: "Texture", min: -100, max: 100 },
  { key: "clarity", label: "Clarity", min: -100, max: 100 },
  { key: "dehaze", label: "Dehaze", min: -100, max: 100 },
  { key: "sharpness", label: "Sharpness", min: -100, max: 100 },
  { key: "noiseReduction", label: "Noise reduction", min: 0, max: 100 },
  { key: "moire", label: "Moiré", min: 0, max: 100 },
  { key: "defringe", label: "Defringe", min: -100, max: 100 },
];

function SliderSection({
  title,
  controls,
  edits,
  defaultOpen,
  onBegin,
  onCommit,
  onChange,
  onReset,
  children,
}: {
  title: string;
  controls: (typeof GLOBAL_SECTIONS)[number]["controls"];
  edits: GlobalAdjustments;
  defaultOpen?: boolean;
  onBegin: () => void;
  onCommit: () => void;
  onChange: InspectorProps["onGlobalChange"];
  onReset: () => void;
  children?: ReactNode;
}) {
  return (
    <Panel
      title={title}
      defaultOpen={defaultOpen}
      action={
        <button type="button" className="panel-reset" title={`Reset ${title}`} onClick={onReset}>
          <RotateCcw size={12} />
        </button>
      }
    >
      <div className="adjustment-list">
        {controls.map((control) => (
          <AdjustmentSlider
            key={control.key}
            label={control.label}
            value={edits[control.key]}
            min={control.min}
            max={control.max}
            step={control.step}
            defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[control.key]}
            onBegin={onBegin}
            onCommit={onCommit}
            onChange={(value) => onChange(control.key, value)}
          />
        ))}
      </div>
      {children ? <div className="editor-subpanels">{children}</div> : null}
    </Panel>
  );
}

function InspectorSubpanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="inspector-subpanel">
      <summary>
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
        <span>{title}</span>
      </summary>
      <div className="inspector-subpanel__body">{children}</div>
    </details>
  );
}

function EditInspector(props: InspectorProps) {
  const { edits } = props.photo;
  const [hslChannel, setHslChannel] = useState<HueChannel>("orange");
  const [curveChannel, setCurveChannel] = useState<"rgb" | "red" | "green" | "blue">("rgb");
  const [mixerMode, setMixerMode] = useState<"mixer" | "point">("mixer");
  const lightSection = GLOBAL_SECTIONS[0];
  const colorSection = GLOBAL_SECTIONS[1];
  const basicControls = [
    ...colorSection.controls.slice(0, 2),
    ...lightSection.controls,
    { key: "texture" as const, label: "Texture", min: -100, max: 100 },
    { key: "clarity" as const, label: "Clarity", min: -100, max: 100 },
    { key: "dehaze" as const, label: "Dehaze", min: -100, max: 100 },
    ...colorSection.controls.slice(2),
  ];
  const effectsControls = GLOBAL_SECTIONS[2].controls.filter((control) =>
    ["vignette", "vignetteMidpoint", "vignetteFeather", "grain", "grainSize"].includes(control.key),
  );

  return (
    <>
      <Panel
        title="Basic"
        defaultOpen
        action={
          <button
            type="button"
            className="panel-reset"
            title="Reset Basic"
            onClick={() => props.onResetSection(basicControls.map((control) => control.key))}
          >
            <RotateCcw size={12} />
          </button>
        }
      >
        <div className="basic-mode-actions">
          <button type="button" onClick={props.onAutoAdjust}>Auto</button>
          <button type="button" onClick={() => props.onProfileChange("Darkroom Monochrome")}>B&amp;W</button>
          <button type="button" disabled title="HDR merge requires bracketed source files">HDR</button>
        </div>
        <div className="profile-row profile-row--classic">
          <span>Profile</span>
          <select
            aria-label="Profile"
            value={canonicalProfileName(edits.profile)}
            onChange={(event) => props.onProfileChange(event.target.value)}
          >
            <option value="Darkroom Color">Darkroom Color</option>
            <option value="Darkroom Vivid">Darkroom Vivid</option>
            <option value="Darkroom Portrait">Darkroom Portrait</option>
            <option value="Darkroom Landscape">Darkroom Landscape</option>
            <option value="Darkroom Monochrome">Darkroom Monochrome</option>
          </select>
        </div>
        <div className="basic-group-label"><span>WB</span><small>As Shot</small></div>
        <div className="adjustment-list">
          {basicControls.slice(0, 2).map((control) => (
            <AdjustmentSlider
              key={control.key}
              label={control.label}
              value={edits.global[control.key]}
              min={control.min}
              max={control.max}
              step={control.step}
              defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[control.key]}
              onBegin={props.onBeginEdit}
              onCommit={props.onCommitEdit}
              onChange={(value) => props.onGlobalChange(control.key, value)}
            />
          ))}
        </div>
        <div className="basic-group-label"><span>Tone</span></div>
        <div className="adjustment-list">
          {lightSection.controls.map((control) => (
            <AdjustmentSlider
              key={control.key}
              label={control.label}
              value={edits.global[control.key]}
              min={control.min}
              max={control.max}
              step={control.step}
              defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[control.key]}
              onBegin={props.onBeginEdit}
              onCommit={props.onCommitEdit}
              onChange={(value) => props.onGlobalChange(control.key, value)}
            />
          ))}
        </div>
        <div className="basic-group-label"><span>Presence</span></div>
        <div className="adjustment-list">
          {basicControls.slice(8).map((control) => (
            <AdjustmentSlider
              key={control.key}
              label={control.label}
              value={edits.global[control.key]}
              min={control.min}
              max={control.max}
              defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[control.key]}
              onBegin={props.onBeginEdit}
              onCommit={props.onCommitEdit}
              onChange={(value) => props.onGlobalChange(control.key, value)}
            />
          ))}
        </div>
      </Panel>
      <Panel title="Tone Curve">
        <div className="classic-curve-tabs" aria-label="Tone curve channels">
          {(["rgb", "red", "green", "blue"] as const).map((channel) => (
            <button
              key={channel}
              type="button"
              className={curveChannel === channel ? "is-active" : ""}
              aria-pressed={curveChannel === channel}
              aria-label={`${channel === "rgb" ? "RGB" : channel} tone curve`}
              onClick={() => setCurveChannel(channel)}
            >
              {channel === "rgb" ? "RGB" : channel[0].toUpperCase()}
            </button>
          ))}
        </div>
        <div className={`classic-curve-editor classic-curve-editor--${curveChannel}`}>
          <CurveEditor
            points={curveChannel === "rgb" ? edits.curve : edits[`${curveChannel}Curve`]}
            onBegin={props.onBeginEdit}
            onChange={(points) => curveChannel === "rgb"
              ? props.onCurveChange(points)
              : props.onColorCurveChange(curveChannel, points)}
            onCommit={props.onCommitEdit}
          />
        </div>
      </Panel>
      <Panel title="Color Mixer">
        <div className="classic-mixer-tabs">
          <button type="button" className={mixerMode === "mixer" ? "is-active" : ""} aria-pressed={mixerMode === "mixer"} onClick={() => setMixerMode("mixer")}>Mixer</button>
          <button type="button" className={mixerMode === "point" ? "is-active" : ""} aria-pressed={mixerMode === "point"} onClick={() => setMixerMode("point")}>Point Color</button>
        </div>
        {mixerMode === "mixer" ? (
          <>
            <div className="hsl-channels">
              {HUE_CHANNELS.map((channel) => (
                <button
                  key={channel}
                  type="button"
                  className={`hsl-channel hsl-channel--${channel} ${hslChannel === channel ? "is-active" : ""}`}
                  aria-pressed={hslChannel === channel}
                  title={channel}
                  aria-label={channel}
                  onClick={() => setHslChannel(channel)}
                />
              ))}
            </div>
            <div className="adjustment-list">
              {(["hue", "saturation", "luminance"] as const).map((key) => (
                <AdjustmentSlider
                  key={key}
                  label={key[0].toUpperCase() + key.slice(1)}
                  value={edits.hsl[hslChannel][key]}
                  min={-100}
                  max={100}
                  onBegin={props.onBeginEdit}
                  onCommit={props.onCommitEdit}
                  onChange={(value) => props.onHslChange(hslChannel, { ...edits.hsl[hslChannel], [key]: value })}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="point-color-controls">
            <label className="point-color-enable">
              <input type="checkbox" checked={edits.pointColor.enabled} onChange={(event) => props.onPointColorChange({ ...edits.pointColor, enabled: event.currentTarget.checked })} />
              <span>Apply Point Color</span>
            </label>
            <div className="point-color-swatch" style={{ "--point-hue": `${edits.pointColor.hue}deg` } as React.CSSProperties} aria-hidden="true" />
            <AdjustmentSlider label="Hue" value={edits.pointColor.hue} min={0} max={360} defaultValue={0} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(hue) => props.onPointColorChange({ ...edits.pointColor, hue, enabled: true })} formatValue={(value) => `${Math.round(value)}°`} />
            <AdjustmentSlider label="Range" value={edits.pointColor.range} min={1} max={100} defaultValue={25} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(range) => props.onPointColorChange({ ...edits.pointColor, range, enabled: true })} />
            <AdjustmentSlider label="Hue Shift" value={edits.pointColor.hueShift} min={-100} max={100} defaultValue={0} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(hueShift) => props.onPointColorChange({ ...edits.pointColor, hueShift, enabled: true })} />
            <AdjustmentSlider label="Saturation Shift" value={edits.pointColor.saturationShift} min={-100} max={100} defaultValue={0} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(saturationShift) => props.onPointColorChange({ ...edits.pointColor, saturationShift, enabled: true })} />
            <AdjustmentSlider label="Luminance Shift" value={edits.pointColor.luminanceShift} min={-100} max={100} defaultValue={0} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(luminanceShift) => props.onPointColorChange({ ...edits.pointColor, luminanceShift, enabled: true })} />
          </div>
        )}
      </Panel>
      <Panel title="Color Grading">
        <div className="grading-controls grading-controls--wheels">
          <div className="grading-wheel-grid">
          {(["shadows", "midtones", "highlights"] as const).map((range) => (
            <ColorGradingWheel
              key={range}
              label={range[0].toUpperCase() + range.slice(1)}
              value={edits.colorGrading[range]}
              onBegin={props.onBeginEdit}
              onCommit={props.onCommitEdit}
              onChange={(value) => props.onColorGradingChange({ ...edits.colorGrading, [range]: value })}
            />
          ))}
          </div>
          <AdjustmentSlider label="Blending" value={edits.colorGrading.blending} min={0} max={100} defaultValue={50} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(blending) => props.onColorGradingChange({ ...edits.colorGrading, blending })} />
          <AdjustmentSlider label="Balance" value={edits.colorGrading.balance} min={-100} max={100} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(balance) => props.onColorGradingChange({ ...edits.colorGrading, balance })} />
        </div>
      </Panel>
      <Panel title="Detail" action={<button type="button" className="panel-reset" title="Reset Detail" onClick={() => props.onResetSection([
        "sharpening", "sharpeningRadius", "sharpeningDetail", "sharpeningMasking",
        "noiseReduction", "noiseReductionDetail", "noiseReductionContrast",
        "colorNoiseReduction", "colorNoiseReductionDetail", "colorNoiseReductionSmoothness",
      ])}><RotateCcw size={12} /></button>}>
        <div className="detail-group-label">Sharpening</div>
        <div className="adjustment-list">
          {([ ["sharpening", "Amount", 0, 150, 1], ["sharpeningRadius", "Radius", 0.5, 3, 0.1], ["sharpeningDetail", "Detail", 0, 100, 1], ["sharpeningMasking", "Masking", 0, 100, 1] ] as const).map(([key, label, min, max, step]) => <AdjustmentSlider key={key} label={label} value={edits.global[key]} min={min} max={max} step={step} defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[key]} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(value) => props.onGlobalChange(key, value)} />)}
        </div>
        <div className="detail-group-label">Noise Reduction</div>
        <div className="adjustment-list">
          {([ ["noiseReduction", "Luminance", 0, 100], ["noiseReductionDetail", "Detail", 0, 100], ["noiseReductionContrast", "Contrast", 0, 100] ] as const).map(([key, label, min, max]) => <AdjustmentSlider key={key} label={label} value={edits.global[key]} min={min} max={max} defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[key]} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(value) => props.onGlobalChange(key, value)} />)}
        </div>
        <div className="detail-group-label">Color Noise Reduction</div>
        <div className="adjustment-list">
          {([ ["colorNoiseReduction", "Color", 0, 100], ["colorNoiseReductionDetail", "Detail", 0, 100], ["colorNoiseReductionSmoothness", "Smoothness", 0, 100] ] as const).map(([key, label, min, max]) => <AdjustmentSlider key={key} label={label} value={edits.global[key]} min={min} max={max} defaultValue={DEFAULT_GLOBAL_ADJUSTMENTS[key]} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(value) => props.onGlobalChange(key, value)} />)}
        </div>
      </Panel>
      <LensCorrectionsPanel value={edits.lensCorrections} metadata={props.photo.metadata} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={props.onLensCorrectionsChange} />
      <Panel title="Transform">
        <div className="upright-heading">
          <span>Upright</span>
          <button
            type="button"
            disabled={edits.geometry.uprightMode === "off" || edits.geometry.uprightMode === "guided"}
            onClick={() => props.onUprightModeChange(edits.geometry.uprightMode, true)}
            title="Analyze the image again using the selected Upright mode"
          >
            Update
          </button>
        </div>
        <div className="geometry-auto geometry-auto--upright" role="group" aria-label="Upright correction mode">
          {([
            ["off", "Off", "Disable automatic Upright correction"],
            ["auto", "Auto", "Balance level and perspective correction"],
            ["guided", "Guided", "Draw two to four lines over edges that should be level or vertical"],
            ["level", "Level", "Correct the dominant horizon"],
            ["vertical", "Vertical", "Correct the horizon and converging verticals"],
            ["full", "Full", "Correct horizontal and vertical perspective"],
          ] as const).map(([mode, label, title]) => (
            <button
              key={mode}
              type="button"
              className={edits.geometry.uprightMode === mode ? "is-active" : undefined}
              aria-pressed={edits.geometry.uprightMode === mode}
              title={title}
              onClick={() => props.onUprightModeChange(mode)}
            >
              {label}
            </button>
          ))}
        </div>
        {edits.geometry.uprightMode === "guided" ? (
          <div className="guided-upright-panel">
            <div className="guided-upright-panel__heading">
              <span>{edits.geometry.guides.length} of 4 guides</span>
              <button
                type="button"
                disabled={!edits.geometry.guides.length}
                onClick={() => props.onUprightGuidesChange([])}
              >
                Clear
              </button>
            </div>
            <p>
              {edits.geometry.guides.length < 2
                ? "Draw at least two guides on the photo. Follow architecture, horizons, or other edges that should be straight."
                : "Drag across another straight edge to refine the correction."}
            </p>
            {edits.geometry.guides.length ? (
              <div className="guided-upright-list" aria-label="Guided Upright guides">
                {edits.geometry.guides.map((guide, index) => (
                  <div key={`${guide.orientation}-${index}`}>
                    <span aria-hidden="true">
                      {guide.orientation === "horizontal" ? "H" : "V"}
                    </span>
                    <strong>
                      {guide.orientation === "horizontal" ? "Horizontal" : "Vertical"} guide {index + 1}
                    </strong>
                    <button
                      type="button"
                      aria-label={`Delete guide ${index + 1}`}
                      title={`Delete guide ${index + 1}`}
                      onClick={() =>
                        props.onUprightGuidesChange(
                          edits.geometry.guides.filter((_, guideIndex) => guideIndex !== index),
                        )
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="adjustment-list">
          {([ ["vertical", "Vertical", -100, 100], ["horizontal", "Horizontal", -100, 100], ["rotate", "Rotate", -180, 180], ["aspect", "Aspect", -100, 100], ["scale", "Scale", 50, 150], ["offsetX", "X Offset", -100, 100], ["offsetY", "Y Offset", -100, 100] ] as const).map(([key, label, min, max]) => (
            <AdjustmentSlider key={key} label={label} value={edits.geometry[key]} min={min} max={max} defaultValue={key === "scale" ? 100 : 0} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={(value) => props.onGeometryChange(key, value)} />
          ))}
        </div>
        <label className="toggle-field transform-constrain-crop">
          <input
            type="checkbox"
            checked={edits.geometry.constrainCrop}
            onChange={(event) => {
              props.onBeginEdit();
              props.onGeometryChange("constrainCrop", event.target.checked);
              props.onCommitEdit();
            }}
          />
          <span>Constrain Crop</span>
        </label>
      </Panel>
      <LensBlurPanel value={edits.lensBlur} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={props.onLensBlurChange} />
      <SliderSection title="Effects" controls={effectsControls} edits={edits.global} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={props.onGlobalChange} onReset={() => props.onResetSection(effectsControls.map((control) => control.key))} />
      <CalibrationPanel value={edits.calibration} onBegin={props.onBeginEdit} onCommit={props.onCommitEdit} onChange={props.onCalibrationChange} />
    </>
  );
}

function CropInspector(props: InspectorProps) {
  const { crop, geometry } = props.photo.edits;
  const applyAspect = (aspect: string) => {
    if (aspect === "Free" || aspect === "Custom") {
      props.onBeginEdit();
      props.onCropChange({ ...crop, aspect, locked: false });
      props.onCommitEdit();
      return;
    }
    const ratios: Record<string, number> = {
      Original: props.photo.width / Math.max(1, props.photo.height),
      "As Shot": props.photo.width / Math.max(1, props.photo.height),
      "1 × 1": 1,
      "4 × 5": 4 / 5,
      "8.5 × 11": 8.5 / 11,
      "5 × 7": 5 / 7,
      "3 × 2": 3 / 2,
      "4 × 3": 4 / 3,
      "16 × 9": 16 / 9,
      "16 × 10": 16 / 10,
    };
    const sourceRatio = props.photo.width / Math.max(1, props.photo.height);
    const normalizedRatio = (ratios[aspect] ?? sourceRatio) / sourceRatio;
    let width = crop.width;
    let height = width / normalizedRatio;
    if (height > crop.height) {
      height = crop.height;
      width = height * normalizedRatio;
    }
    props.onBeginEdit();
    props.onCropChange({
      ...crop,
      x: crop.x + (crop.width - width) / 2,
      y: crop.y + (crop.height - height) / 2,
      width,
      height,
      aspect,
      locked: true,
    });
    props.onCommitEdit();
  };

  return (
    <>
      <div className="inspector-tool-heading">
        <div>
          <Crop size={17} />
          <strong>Crop &amp; Straighten</strong>
        </div>
        <span className="crop-heading-actions">
          <button
            type="button"
            onClick={() => {
              props.onBeginEdit();
              props.onCropChange({
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                aspect: "Original",
                locked: false,
                angle: 0,
              });
              props.onCommitEdit();
            }}
          >
            Reset
          </button>
          <button type="button" onClick={() => props.onToolChange("edit")}>Close</button>
        </span>
      </div>
      <Panel title="Crop" defaultOpen>
        <div className="field-grid">
          <label>
            <span>Aspect</span>
            <select
              value={crop.aspect}
              onChange={(event) => applyAspect(event.target.value)}
            >
              <option>As Shot</option>
              <option>Original</option>
              <option>Custom</option>
              <option>Free</option>
              <option>1 × 1</option>
              <option>4 × 5</option>
              <option>8.5 × 11</option>
              <option>5 × 7</option>
              <option>3 × 2</option>
              <option>4 × 3</option>
              <option>16 × 9</option>
              <option>16 × 10</option>
            </select>
          </label>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={crop.locked}
              onChange={(event) => {
                props.onBeginEdit();
                props.onCropChange({ ...crop, locked: event.target.checked });
                props.onCommitEdit();
              }}
            />
            <span>Lock ratio</span>
          </label>
        </div>
        <AdjustmentSlider
          label="Angle"
          value={crop.angle}
          min={-45}
          max={45}
          step={0.1}
          onBegin={props.onBeginEdit}
          onCommit={props.onCommitEdit}
          onChange={(value) => props.onCropChange({ ...crop, angle: value })}
          formatValue={(value) => `${value.toFixed(1)}°`}
        />
        <div className="geometry-auto crop-auto-row">
          <button type="button" onClick={() => props.onUprightModeChange("level")}>Auto</button>
        </div>
        <label className="toggle-field">
          <input
            type="checkbox"
            checked={geometry.constrainCrop}
            onChange={(event) => {
              props.onBeginEdit();
              props.onGeometryChange("constrainCrop", event.target.checked);
              props.onCommitEdit();
            }}
          />
          <span>Constrain to Image</span>
        </label>
        <label className="field crop-overlay-field">
          <span className="field__label">Tool Overlay</span>
          <select
            value={props.cropOverlay}
            aria-label="Crop tool overlay"
            onChange={(event) =>
              props.onCropOverlayChange(event.target.value as CropOverlay)
            }
          >
            <option value="thirds">Rule of Thirds</option>
            <option value="grid">Grid</option>
            <option value="diagonal">Diagonal</option>
            <option value="golden-ratio">Golden Ratio</option>
          </select>
        </label>
      </Panel>
    </>
  );
}

type MaskCreationOption = {
  kind: MaskKind;
  label: string;
  icon: typeof Brush;
  description: string;
  estimateLabel?: string;
};

const MASK_CREATION_GROUPS: {
  id: "ai" | "manual" | "range";
  label: string;
  description: string;
  options: MaskCreationOption[];
}[] = [
  {
    id: "ai",
    label: "AI",
    description: "Local estimates — refine the result after creating it.",
    options: [
      {
        kind: "subject",
        label: "Subject",
        icon: UserRound,
        description: "Estimate the main subject locally",
        estimateLabel: "Local estimate",
      },
      {
        kind: "sky",
        label: "Sky",
        icon: CloudSun,
        description: "Estimate the sky locally",
        estimateLabel: "Local estimate",
      },
      {
        kind: "background",
        label: "Background",
        icon: Aperture,
        description: "Estimate the area behind the main subject locally",
        estimateLabel: "Local estimate",
      },
      {
        kind: "object",
        label: "Object",
        icon: LocateFixed,
        description: "Estimate an object inside a chosen region locally",
        estimateLabel: "Local estimate",
      },
      {
        kind: "people",
        label: "People",
        icon: UserRound,
        description: "Estimate people or selected features locally",
        estimateLabel: "Local estimate",
      },
      {
        kind: "landscape",
        label: "Landscape",
        icon: CloudSun,
        description: "Estimate a landscape element locally",
        estimateLabel: "Local estimate",
      },
    ],
  },
  {
    id: "manual",
    label: "Manual",
    description: "Draw a selection directly on the photograph.",
    options: [
      {
        kind: "brush",
        label: "Brush",
        icon: Brush,
        description: "Paint a freeform selection",
      },
      {
        kind: "linear",
        label: "Linear Gradient",
        icon: Blend,
        description: "Fade a selection across the frame",
      },
      {
        kind: "radial",
        label: "Radial Gradient",
        icon: CircleDotDashed,
        description: "Draw an elliptical selection",
      },
    ],
  },
  {
    id: "range",
    label: "Range",
    description: "Select pixels by tone, color, or estimated depth.",
    options: [
      {
        kind: "luminance",
        label: "Luminance Range",
        icon: SunMedium,
        description: "Select a tonal range",
      },
      {
        kind: "color",
        label: "Color Range",
        icon: Aperture,
        description: "Select a color range",
      },
      {
        kind: "depth",
        label: "Depth Range",
        icon: Blend,
        description: "Estimate a distance range locally",
        estimateLabel: "Estimated depth",
      },
    ],
  },
];

const MASK_OPTIONS = MASK_CREATION_GROUPS.flatMap((group) => group.options);

const togglePeopleFeature = (
  current: readonly PeopleFeature[],
  feature: PeopleFeature,
): PeopleFeature[] => {
  if (feature === "wholePerson") return ["wholePerson"];
  const partFeatures = current.filter(
    (candidate) => candidate !== "wholePerson",
  );
  if (partFeatures.includes(feature)) {
    const next = partFeatures.filter((candidate) => candidate !== feature);
    return next.length ? next : [feature];
  }
  return [...partFeatures, feature];
};

const MASK_OPERATION_LABELS: Record<MaskComponent["operation"], string> = {
  add: "Add",
  subtract: "Subtract",
  intersect: "Intersect",
};

function MaskComponentMenu({
  groupId,
  operation,
  onAdd,
}: {
  groupId: string;
  operation: MaskComponent["operation"];
  onAdd: InspectorProps["onAddMaskComponent"];
}) {
  const Icon =
    operation === "add" ? Plus : operation === "subtract" ? Minus : Focus;
  const label = MASK_OPERATION_LABELS[operation];
  return (
    <details
      className={`mask-combine-menu mask-combine-menu--${operation}`}
    >
      <summary title={`${label} a component`}>
        <Icon size={12} aria-hidden="true" />
        <span>{label}</span>
      </summary>
      <div
        className="mask-combine-menu__popover"
        role="group"
        aria-label={`${label} mask component`}
      >
        {MASK_CREATION_GROUPS.map((group) => (
          <div className="mask-combine-menu__group" key={group.id}>
            <strong>{group.label}</strong>
            {group.options.map(
              ({
                kind,
                label: optionLabel,
                icon: OptionIcon,
                estimateLabel,
              }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={(event) => {
                    onAdd(groupId, kind, operation);
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                  }}
                >
                  <OptionIcon size={13} aria-hidden="true" />
                  <span>{optionLabel}</span>
                  {estimateLabel && !optionLabel.includes("(estimated)") ? (
                    <small>{estimateLabel}</small>
                  ) : null}
                </button>
              ),
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function MaskInspector(props: InspectorProps) {
  const [peopleDraftFeatures, setPeopleDraftFeatures] = useState<PeopleFeature[]>([
    "wholePerson",
  ]);
  const [peopleCreateMode, setPeopleCreateMode] = useState<
    "combined" | "separate"
  >("combined");
  const selectedMask =
    props.photo.edits.masks.find((mask) => mask.id === props.activeMaskId) ?? null;
  const selectedMaskComponents = selectedMask
    ? getMaskComponents(selectedMask)
    : [];
  const selectedComponent =
    selectedMaskComponents.find(
      (component) => component.id === props.activeMaskComponentId,
    ) ??
    selectedMaskComponents[0] ??
    null;
  const selectedComponentOption = selectedComponent
    ? MASK_OPTIONS.find((option) => option.kind === selectedComponent.kind)
    : null;
  const SelectedComponentIcon = selectedComponentOption?.icon ?? CircleDashed;

  const selectMaskGroup = (mask: Mask) => {
    props.onSelectMask(mask.id);
    const components = getMaskComponents(mask);
    const component =
      components.find(
        (candidate) => candidate.id === props.activeMaskComponentId,
      ) ?? components[0];
    if (component) {
      props.onSelectMaskComponent(mask.id, component.id);
    }
  };

  const selectMaskComponent = (mask: Mask, component: MaskComponent) => {
    props.onSelectMask(mask.id);
    props.onSelectMaskComponent(mask.id, component.id);
  };

  const updateSelectedComponent = (patch: Partial<MaskComponent>) => {
    if (!selectedMask || !selectedComponent) return;
    props.onUpdateMaskComponent(
      selectedMask.id,
      selectedComponent.id,
      patch,
    );
  };

  const deleteSelectedComponent = () => {
    if (!selectedMask || !selectedComponent) return;
    props.onDeleteMaskComponent(selectedMask.id, selectedComponent.id);
  };

  const renderCreationOption = (
    option: MaskCreationOption,
    variant: "card" | "row" = "row",
  ) => {
    const Icon = option.icon;
    return (
      <button
        className={`mask-create-compact-option mask-create-compact-option--${variant}`}
        key={option.kind}
        type="button"
        title={option.description}
        disabled={props.photo.edits.masks.length >= 8}
        onClick={() => props.onCreateMask(option.kind)}
      >
        <Icon size={variant === "card" ? 18 : 15} strokeWidth={1.55} aria-hidden="true" />
        <span>
          <strong>{option.label}</strong>
          {option.estimateLabel ? <small>Estimated</small> : null}
        </span>
      </button>
    );
  };

  const topOptions = (["subject", "sky", "background"] as const)
    .map((kind) => MASK_OPTIONS.find((option) => option.kind === kind))
    .filter((option): option is MaskCreationOption => Boolean(option));
  const manualOptions = ([
    "landscape",
    "object",
    "brush",
    "linear",
    "radial",
    "luminance",
    "color",
    "depth",
  ] as const)
    .map((kind) => MASK_OPTIONS.find((option) => option.kind === kind))
    .filter((option): option is MaskCreationOption => Boolean(option));
  const peopleOption = MASK_OPTIONS.find((option) => option.kind === "people");
  const peopleMasksToCreate =
    peopleCreateMode === "separate" ? peopleDraftFeatures.length : 1;
  const peopleMaskCapacity = 8 - props.photo.edits.masks.length;

  return (
    <>
      <div className="inspector-tool-heading">
        <div>
          <CircleDashed size={17} />
          <strong>Masks</strong>
        </div>
        <span>{props.photo.edits.masks.length ? `${props.photo.edits.masks.length} masks` : ""}</span>
      </div>
      <Panel
        title="Add New Mask"
        defaultOpen={!props.photo.edits.masks.length}
        className="mask-create-panel"
      >
        <div className="mask-create-compact">
          <div className="mask-create-compact__cards">
            {topOptions.map((option) => renderCreationOption(option, "card"))}
          </div>
          <div className="mask-create-compact__rows">
            {manualOptions.map((option) => renderCreationOption(option))}
          </div>
          {peopleOption ? (
            <section className="mask-create-compact__people">
              <div className="people-mask-card__heading">
                <span className="people-mask-card__avatar" aria-hidden="true">
                  <UserRound size={17} strokeWidth={1.5} />
                </span>
                <span>
                  <strong>Person 1</strong>
                  <small>One locally estimated candidate</small>
                </span>
              </div>
              <p className="people-mask-card__note">
                Local pixel analysis only. Refine the estimate after creating it.
              </p>
              <fieldset className="people-feature-picker">
                <legend>Features</legend>
                {PEOPLE_FEATURES.map((feature) => (
                  <label key={feature}>
                    <input
                      type="checkbox"
                      checked={peopleDraftFeatures.includes(feature)}
                      onChange={() =>
                        setPeopleDraftFeatures((current) =>
                          togglePeopleFeature(current, feature),
                        )
                      }
                    />
                    <span>{PEOPLE_FEATURE_LABELS[feature]}</span>
                    {feature === "facialHair" ? <small>When present</small> : null}
                  </label>
                ))}
              </fieldset>
              <fieldset className="people-mask-create-mode">
                <legend>Create as</legend>
                <label>
                  <input
                    type="radio"
                    name="people-mask-create-mode"
                    checked={peopleCreateMode === "combined"}
                    onChange={() => setPeopleCreateMode("combined")}
                  />
                  <span>One combined mask</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="people-mask-create-mode"
                    checked={peopleCreateMode === "separate"}
                    onChange={() => setPeopleCreateMode("separate")}
                  />
                  <span>Separate masks</span>
                </label>
              </fieldset>
              <button
                type="button"
                className="people-mask-create-button"
                disabled={peopleMasksToCreate > peopleMaskCapacity}
                onClick={() =>
                  props.onCreatePeopleMasks(
                    peopleDraftFeatures,
                    peopleCreateMode === "separate",
                  )
                }
              >
                {peopleCreateMode === "separate"
                  ? `Create ${peopleMasksToCreate} ${
                      peopleMasksToCreate === 1 ? "mask" : "masks"
                    }`
                  : "Create combined mask"}
              </button>
              {peopleMasksToCreate > peopleMaskCapacity ? (
                <small className="people-mask-card__limit">
                  Only {peopleMaskCapacity} mask {peopleMaskCapacity === 1 ? "slot" : "slots"} remaining.
                </small>
              ) : null}
            </section>
          ) : null}
        </div>
      </Panel>
      {props.photo.edits.masks.length ? (
        <div
          className="mask-tree"
          role="list"
          aria-label="Masks and components"
        >
          {props.photo.edits.masks.map((mask) => {
            const components = getMaskComponents(mask);
            const isActive = mask.id === props.activeMaskId;
            return (
              <section
                className={`mask-tree__group ${isActive ? "is-active" : ""}`}
                key={mask.id}
                role="listitem"
              >
                <button
                  type="button"
                  className="mask-tree__group-row"
                  aria-pressed={isActive}
                  aria-label={`${mask.name}, ${components.length} ${
                    components.length === 1 ? "component" : "components"
                  }, ${mask.enabled ? "enabled" : "disabled"}`}
                  onClick={() => selectMaskGroup(mask)}
                >
                  <span
                    className="mask-tree__swatch"
                    style={{ backgroundColor: mask.overlayColor }}
                  />
                  <span className="mask-tree__group-copy">
                    <strong>{mask.name}</strong>
                    <small>
                      {components.length}{" "}
                      {components.length === 1 ? "component" : "components"}
                    </small>
                  </span>
                  <span
                    className={`mask-tree__status ${mask.enabled ? "is-on" : ""}`}
                    title={mask.enabled ? "Mask enabled" : "Mask disabled"}
                  />
                </button>
                <div
                  className="mask-tree__components"
                  role="group"
                  aria-label={`${mask.name} components`}
                >
                  {components.map((component) => {
                    const option = MASK_OPTIONS.find(
                      (candidate) => candidate.kind === component.kind,
                    );
                    const ComponentIcon = option?.icon ?? CircleDashed;
                    const componentIsActive =
                      isActive && component.id === selectedComponent?.id;
                    return (
                      <button
                        key={component.id}
                        type="button"
                        className={`mask-tree__component-row ${
                          componentIsActive ? "is-active" : ""
                        }`}
                        aria-pressed={componentIsActive}
                        aria-label={`${component.name}, ${
                          MASK_OPERATION_LABELS[component.operation]
                        } ${option?.label ?? component.kind}, ${
                          component.enabled ? "enabled" : "disabled"
                        }`}
                        onClick={() => selectMaskComponent(mask, component)}
                      >
                        <span
                          className={
                            `mask-tree__operation-badge ` +
                            `mask-tree__operation-badge--${component.operation}`
                          }
                          title={MASK_OPERATION_LABELS[component.operation]}
                        >
                          {component.operation === "add" ? (
                            <Plus size={10} aria-hidden="true" />
                          ) : component.operation === "subtract" ? (
                            <Minus size={10} aria-hidden="true" />
                          ) : (
                            <Focus size={10} aria-hidden="true" />
                          )}
                        </span>
                        <ComponentIcon size={13} aria-hidden="true" />
                        <span className="mask-tree__component-copy">
                          <strong>{component.name}</strong>
                          <small>{option?.label ?? component.kind}</small>
                        </span>
                        <span
                          className={`mask-tree__status ${
                            component.enabled ? "is-on" : ""
                          }`}
                          title={
                            component.enabled
                              ? "Component enabled"
                              : "Component disabled"
                          }
                        />
                      </button>
                    );
                  })}
                </div>
                {isActive ? (
                  <div
                    className="mask-tree__combine-actions"
                    role="group"
                    aria-label={`Combine components in ${mask.name}`}
                  >
                    {components.length < 32 ? (
                      (["add", "subtract", "intersect"] as const).map(
                        (operation) => (
                          <MaskComponentMenu
                            key={operation}
                            groupId={mask.id}
                            operation={operation}
                            onAdd={props.onAddMaskComponent}
                          />
                        ),
                      )
                    ) : (
                      <small className="mask-tree__component-limit">
                        32-component limit reached
                      </small>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="mask-empty">
          <LocateFixed size={22} strokeWidth={1.3} />
          <p>Create a mask to adjust one part of the image without changing the rest.</p>
        </div>
      )}
      {selectedMask ? (
        <>
          <Panel title="Mask group" defaultOpen className="mask-group-panel">
            <label className="field mask-group-name-field">
              <span className="field__label">Name</span>
              <input
                key={`${selectedMask.id}-${selectedMask.name}`}
                type="text"
                className="text-input"
                defaultValue={selectedMask.name}
                maxLength={80}
                aria-label="Mask group name"
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (!name) {
                    event.currentTarget.value = selectedMask.name;
                  } else if (name !== selectedMask.name) {
                    props.onBeginEdit();
                    props.onRenameMask(selectedMask.id, name);
                    props.onCommitEdit();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.currentTarget.value = selectedMask.name;
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            <div className="mask-group-toggles">
              <label className="mask-toggle">
                <input
                  type="checkbox"
                  checked={selectedMask.enabled}
                  onChange={(event) => {
                    props.onBeginEdit();
                    props.onUpdateMask(selectedMask.id, {
                      enabled: event.target.checked,
                    });
                    props.onCommitEdit();
                  }}
                />
                <span>Enabled</span>
              </label>
              <button
                type="button"
                className={selectedMask.inverted ? "is-active" : ""}
                aria-pressed={selectedMask.inverted}
                onClick={() => {
                  props.onBeginEdit();
                  props.onUpdateMask(selectedMask.id, {
                    inverted: !selectedMask.inverted,
                  });
                  props.onCommitEdit();
                }}
              >
                Invert group
              </button>
            </div>
            <AdjustmentSlider
              label="Group opacity"
              value={Math.round(selectedMask.opacity * 100)}
              min={0}
              max={100}
              defaultValue={100}
              onBegin={props.onBeginEdit}
              onCommit={props.onCommitEdit}
              onChange={(value) =>
                props.onUpdateMask(selectedMask.id, {
                  opacity: value / 100,
                })
              }
              formatValue={(value) => `${Math.round(value)}%`}
            />
            <div className="mask-group-actions">
              <button
                type="button"
                title="Duplicate mask group"
                disabled={props.photo.edits.masks.length >= 8}
                onClick={() => props.onDuplicateMask(selectedMask.id)}
              >
                <Copy size={13} aria-hidden="true" />
                <span>Duplicate</span>
              </button>
              <button
                type="button"
                title="Duplicate and invert mask group"
                disabled={props.photo.edits.masks.length >= 8}
                onClick={() => props.onDuplicateMask(selectedMask.id, true)}
              >
                <Copy size={13} aria-hidden="true" />
                <span>Duplicate + invert</span>
              </button>
              <button
                type="button"
                className="danger-button"
                title="Delete mask group"
                aria-label="Delete mask group"
                onClick={() => props.onDeleteMask(selectedMask.id)}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          </Panel>
          {selectedComponent ? (
            <Panel
              title="Component"
              defaultOpen
              className="mask-component-panel"
            >
              <div className="mask-component-heading">
                <span className="mask-component-heading__icon">
                  <SelectedComponentIcon size={14} aria-hidden="true" />
                </span>
                <span className="mask-component-heading__copy">
                  <strong>{selectedComponent.name}</strong>
                  <small>
                    {MASK_OPERATION_LABELS[selectedComponent.operation]} ·{" "}
                    {selectedComponentOption?.label ?? selectedComponent.kind}
                  </small>
                </span>
              </div>
              <div className="mask-component-actions">
                <label className="mask-toggle">
                  <input
                    type="checkbox"
                    checked={selectedComponent.enabled}
                    onChange={(event) => {
                      props.onBeginEdit();
                      updateSelectedComponent({
                        enabled: event.target.checked,
                      });
                      props.onCommitEdit();
                    }}
                  />
                  <span>Enabled</span>
                </label>
                <button
                  type="button"
                  className={selectedComponent.inverted ? "is-active" : ""}
                  aria-pressed={selectedComponent.inverted}
                  onClick={() => {
                    props.onBeginEdit();
                    updateSelectedComponent({
                      inverted: !selectedComponent.inverted,
                    });
                    props.onCommitEdit();
                  }}
                >
                  Invert component
                </button>
                <button
                  type="button"
                  className="danger-button"
                  title={
                    selectedMaskComponents.length <= 1
                      ? "Delete mask group"
                      : "Delete component"
                  }
                  aria-label={
                    selectedMaskComponents.length <= 1
                      ? "Delete mask group"
                      : "Delete component"
                  }
                  onClick={deleteSelectedComponent}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
              <AdjustmentSlider
                label="Component opacity"
                value={Math.round(selectedComponent.opacity * 100)}
                min={0}
                max={100}
                defaultValue={100}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(value) =>
                  updateSelectedComponent({ opacity: value / 100 })
                }
                formatValue={(value) => `${Math.round(value)}%`}
              />
              {selectedComponentOption?.estimateLabel ? (
                <p className="mask-component-estimate-note">
                  {selectedComponent.kind === "depth"
                    ? "Depth is estimated locally; embedded depth maps are not currently used."
                    : selectedComponent.kind === "people"
                      ? "Person 1 and its features are estimated locally; no connected identity or cloud model is used."
                    : "This selection is a local estimate."}{" "}
                  Refine it with Add, Subtract, or Intersect components.
                </p>
              ) : null}
            </Panel>
          ) : null}
          {selectedComponent?.kind === "brush" ? (
            <Panel title="Brush settings" defaultOpen>
              <AdjustmentSlider
                label="Size"
                value={props.maskBrushSettings.size}
                min={2}
                max={100}
                defaultValue={34}
                onChange={(size) =>
                  props.onMaskBrushSettingsChange({
                    ...props.maskBrushSettings,
                    size,
                  })
                }
              />
              <AdjustmentSlider
                label="Feather"
                value={props.maskBrushSettings.feather}
                min={0}
                max={100}
                defaultValue={65}
                onChange={(feather) =>
                  props.onMaskBrushSettingsChange({
                    ...props.maskBrushSettings,
                    feather,
                  })
                }
              />
              <AdjustmentSlider
                label="Flow"
                value={props.maskBrushSettings.flow}
                min={1}
                max={100}
                defaultValue={82}
                onChange={(flow) =>
                  props.onMaskBrushSettingsChange({
                    ...props.maskBrushSettings,
                    flow,
                  })
                }
              />
              <AdjustmentSlider
                label="Density"
                value={props.maskBrushSettings.density}
                min={1}
                max={100}
                defaultValue={100}
                onChange={(density) =>
                  props.onMaskBrushSettingsChange({
                    ...props.maskBrushSettings,
                    density,
                  })
                }
              />
              <div className="mask-brush-toggles">
                <label className="mask-toggle">
                  <input
                    type="checkbox"
                    checked={props.maskBrushSettings.autoMask}
                    onChange={(event) =>
                      props.onMaskBrushSettingsChange({
                        ...props.maskBrushSettings,
                        autoMask: event.target.checked,
                      })
                    }
                  />
                  <span>Auto mask</span>
                </label>
                <label className="mask-toggle">
                  <input
                    type="checkbox"
                    checked={props.maskBrushSettings.erase}
                    onChange={(event) =>
                      props.onMaskBrushSettingsChange({
                        ...props.maskBrushSettings,
                        erase: event.target.checked,
                      })
                    }
                  />
                  <span>Erase</span>
                </label>
              </div>
            </Panel>
          ) : null}
          {selectedComponent?.kind === "radial" &&
          selectedComponent.radial ? (
            <Panel title="Radial range" defaultOpen>
              <p className="field__hint mask-component-help">
                Drag on the image to draw or reposition the radial range.
              </p>
              <AdjustmentSlider
                label="Feather"
                value={selectedComponent.radial.feather}
                min={0}
                max={100}
                defaultValue={55}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(feather) =>
                  updateSelectedComponent({
                    radial: { ...selectedComponent.radial!, feather },
                  })
                }
                formatValue={(value) => `${Math.round(value)}%`}
              />
              <AdjustmentSlider
                label="Rotation"
                value={selectedComponent.radial.rotation}
                min={-180}
                max={180}
                step={0.1}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(rotation) =>
                  updateSelectedComponent({
                    radial: { ...selectedComponent.radial!, rotation },
                  })
                }
                formatValue={(value) => `${value.toFixed(1)}°`}
              />
            </Panel>
          ) : null}
          {selectedComponent?.kind === "object" &&
          selectedComponent.object ? (
            <Panel title="Object region" defaultOpen>
              <p className="field__hint mask-component-help">
                Drag on the image to draw the object rectangle, or fine-tune
                its bounds here.
              </p>
              <div className="adjustment-list">
                {(
                  [
                    ["x", "Left"],
                    ["y", "Top"],
                    ["width", "Width"],
                    ["height", "Height"],
                  ] as const
                ).map(([key, label]) => (
                  <AdjustmentSlider
                    key={key}
                    label={label}
                    value={selectedComponent.object![key] * 100}
                    min={0}
                    max={100}
                    defaultValue={
                      key === "x" || key === "y" ? 30 : 40
                    }
                    onBegin={props.onBeginEdit}
                    onCommit={props.onCommitEdit}
                    onChange={(value) =>
                      updateSelectedComponent({
                        object: {
                          ...selectedComponent.object!,
                          [key]: value / 100,
                        },
                      })
                    }
                    formatValue={(value) => `${Math.round(value)}%`}
                  />
                ))}
              </div>
            </Panel>
          ) : null}
          {selectedComponent?.kind === "people" &&
          selectedComponent.people ? (
            <Panel title="Person 1 features" defaultOpen>
              <p className="field__hint mask-component-help">
                Local estimate. Select one or more features; whole person replaces
                individual feature selections.
              </p>
              <div
                className="people-feature-picker people-feature-picker--component"
                role="group"
                aria-label="Person 1 features"
              >
                {PEOPLE_FEATURES.map((feature) => {
                  const selectedFeatures = normalizePeopleFeatures(
                    selectedComponent.people?.features,
                    selectedComponent.people?.region,
                  );
                  return (
                    <label key={feature}>
                      <input
                        type="checkbox"
                        checked={selectedFeatures.includes(feature)}
                        onChange={() => {
                          const features = togglePeopleFeature(
                            selectedFeatures,
                            feature,
                          );
                          props.onBeginEdit();
                          updateSelectedComponent({
                            people: {
                              region: legacyRegionForPeopleFeatures(features),
                              features,
                              personId: "person-1",
                            },
                          });
                          props.onCommitEdit();
                        }}
                      />
                      <span>{PEOPLE_FEATURE_LABELS[feature]}</span>
                      {feature === "facialHair" ? <small>When present</small> : null}
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className="people-mask-reset-button"
                onClick={() => {
                    props.onBeginEdit();
                    updateSelectedComponent({
                      people: {
                        region: "all",
                        features: ["wholePerson"],
                        personId: "person-1",
                      },
                    });
                    props.onCommitEdit();
                  }}
              >
                Select whole person
              </button>
            </Panel>
          ) : null}
          {selectedComponent?.kind === "landscape" &&
          selectedComponent.landscape ? (
            <Panel title="Landscape element" defaultOpen>
              <label className="field mask-region-field">
                <span className="field__label">Include</span>
                <select
                  value={selectedComponent.landscape.element}
                  onChange={(event) => {
                    props.onBeginEdit();
                    updateSelectedComponent({
                      landscape: {
                        element: event.target.value as NonNullable<
                          MaskComponent["landscape"]
                        >["element"],
                      },
                    });
                    props.onCommitEdit();
                  }}
                >
                  <option value="sky">Sky</option>
                  <option value="mountains">Mountains</option>
                  <option value="architecture">Architecture</option>
                  <option value="vegetation">Vegetation</option>
                  <option value="water">Water</option>
                  <option value="snow">Snow</option>
                  <option value="ground">Ground</option>
                </select>
              </label>
            </Panel>
          ) : null}
          {selectedComponent?.kind === "luminance" &&
          selectedComponent.luminance ? (
            <Panel title="Luminance range" defaultOpen>
              <p className="field__hint mask-component-help">
                Click the image to sample a luminance range.
              </p>
              <AdjustmentSlider
                label="Minimum"
                value={selectedComponent.luminance.min}
                min={0}
                max={100}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(min) =>
                  updateSelectedComponent({
                    luminance: { ...selectedComponent.luminance!, min },
                  })
                }
              />
              <AdjustmentSlider
                label="Maximum"
                value={selectedComponent.luminance.max}
                min={0}
                max={100}
                defaultValue={100}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(max) =>
                  updateSelectedComponent({
                    luminance: { ...selectedComponent.luminance!, max },
                  })
                }
              />
              <AdjustmentSlider
                label="Smoothness"
                value={selectedComponent.luminance.smoothness}
                min={0}
                max={100}
                defaultValue={20}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(smoothness) =>
                  updateSelectedComponent({
                    luminance: {
                      ...selectedComponent.luminance!,
                      smoothness,
                    },
                  })
                }
              />
            </Panel>
          ) : null}
          {selectedComponent?.kind === "depth" && selectedComponent.depth ? (
            <Panel title="Depth range (estimated)" defaultOpen>
              <AdjustmentSlider
                label="Near"
                value={selectedComponent.depth.min}
                min={0}
                max={100}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(min) =>
                  updateSelectedComponent({
                    depth: { ...selectedComponent.depth!, min },
                  })
                }
                formatValue={(value) => `${Math.round(value)}%`}
              />
              <AdjustmentSlider
                label="Far"
                value={selectedComponent.depth.max}
                min={0}
                max={100}
                defaultValue={100}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(max) =>
                  updateSelectedComponent({
                    depth: { ...selectedComponent.depth!, max },
                  })
                }
                formatValue={(value) => `${Math.round(value)}%`}
              />
              <AdjustmentSlider
                label="Smoothness"
                value={selectedComponent.depth.smoothness}
                min={0}
                max={100}
                defaultValue={35}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(smoothness) =>
                  updateSelectedComponent({
                    depth: { ...selectedComponent.depth!, smoothness },
                  })
                }
                formatValue={(value) => `${Math.round(value)}%`}
              />
            </Panel>
          ) : null}
          {selectedComponent?.kind === "color" && selectedComponent.color ? (
            <Panel title="Color range" defaultOpen>
              <p className="field__hint mask-component-help">
                Click the image to sample the target color.
              </p>
              <label className="color-range-picker">
                <span>Target color</span>
                <input
                  type="color"
                  value={`#${[
                    selectedComponent.color.r,
                    selectedComponent.color.g,
                    selectedComponent.color.b,
                  ]
                    .map((channel) =>
                      Math.round(Math.max(0, Math.min(1, channel)) * 255)
                        .toString(16)
                        .padStart(2, "0"),
                    )
                    .join("")}`}
                  onChange={(event) => {
                    const value = event.target.value.slice(1);
                    props.onBeginEdit();
                    updateSelectedComponent({
                      color: {
                        ...selectedComponent.color!,
                        r: Number.parseInt(value.slice(0, 2), 16) / 255,
                        g: Number.parseInt(value.slice(2, 4), 16) / 255,
                        b: Number.parseInt(value.slice(4, 6), 16) / 255,
                      },
                    });
                    props.onCommitEdit();
                  }}
                />
              </label>
              <AdjustmentSlider
                label="Tolerance"
                value={selectedComponent.color.tolerance}
                min={1}
                max={100}
                defaultValue={28}
                onBegin={props.onBeginEdit}
                onCommit={props.onCommitEdit}
                onChange={(tolerance) =>
                  updateSelectedComponent({
                    color: { ...selectedComponent.color!, tolerance },
                  })
                }
              />
            </Panel>
          ) : null}
          <Panel title="Overlay" defaultOpen className="mask-overlay-panel">
            <label className="field mask-overlay-mode-field">
              <span className="field__label">Mode</span>
              <select
                value={props.overlayMode}
                onChange={(event) =>
                  props.onOverlayModeChange(
                    event.target.value as MaskOverlayMode,
                  )
                }
              >
                <option value="color">Color</option>
                <option value="color-on-black">Color on black</option>
                <option value="color-on-white">Color on white</option>
                <option value="white-on-black">White on black</option>
                <option value="black-on-white">Black on white</option>
              </select>
            </label>
            <label
              className={`mask-overlay-color-field ${
                props.overlayMode.startsWith("color") ? "" : "is-disabled"
              }`}
            >
              <span>Overlay color</span>
              <input
                type="color"
                value={selectedMask.overlayColor}
                disabled={!props.overlayMode.startsWith("color")}
                onChange={(event) => {
                  props.onBeginEdit();
                  props.onUpdateMask(selectedMask.id, {
                    overlayColor: event.target.value,
                  });
                  props.onCommitEdit();
                }}
              />
            </label>
            <AdjustmentSlider
              label="Overlay opacity"
              value={Math.round(props.overlayOpacity * 100)}
              min={0}
              max={100}
              defaultValue={50}
              onChange={(value) => props.onOverlayOpacityChange(value / 100)}
              formatValue={(value) => `${Math.round(value)}%`}
            />
          </Panel>
          <Panel title="Local adjustments" defaultOpen>
            <div className="adjustment-list">
              {LOCAL_CONTROLS.map((control) => (
                <AdjustmentSlider
                  key={control.key}
                  label={control.label}
                  value={selectedMask.adjustments[control.key]}
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  onBegin={props.onBeginEdit}
                  onCommit={props.onCommitEdit}
                  onChange={(value) =>
                    props.onUpdateMaskAdjustments(selectedMask.id, {
                      [control.key]: value,
                    })
                  }
                />
              ))}
            </div>
          </Panel>
        </>
      ) : null}
    </>
  );
}

function HealInspector(props: Pick<
  InspectorProps,
  | "photo"
  | "healSettings"
  | "activeHealSpotId"
  | "healOverlayMode"
  | "visualizeSpots"
  | "visualizeSpotsThreshold"
  | "onHealSettingsChange"
  | "onRemoveHealSpot"
  | "onUpdateHealSpot"
  | "onRecenterHealSource"
  | "onActiveHealSpotChange"
  | "onHealOverlayModeChange"
  | "onVisualizeSpotsChange"
  | "onVisualizeSpotsThresholdChange"
  | "onResetHealSpots"
  | "onCloseHeal"
  | "onBeginEdit"
  | "onCommitEdit"
>) {
  const activeSpot = props.photo.edits.healSpots.find(
    (spot) => spot.id === props.activeHealSpotId,
  ) ?? null;
  const modes = [
    { mode: "remove" as const, label: "Remove", icon: Sparkles },
    { mode: "heal" as const, label: "Heal", icon: Bandage },
    { mode: "clone" as const, label: "Clone", icon: Copy },
  ];

  return (
    <div className="remove-inspector">
      <div className="inspector-tool-heading">
        <div>
          <Bandage size={17} />
          <strong>Remove</strong>
        </div>
      </div>
      <div className="remove-mode-row">
        <span>Mode:</span>
        <div role="group" aria-label="Repair mode">
          {modes.map(({ mode, label, icon: ModeIcon }) => (
            <button
              key={mode}
              type="button"
              className={props.healSettings.mode === mode ? "is-active" : undefined}
              aria-label={label}
              aria-pressed={props.healSettings.mode === mode}
              title={label}
              onClick={() => props.onHealSettingsChange({ ...props.healSettings, mode })}
            >
              <ModeIcon size={15} />
            </button>
          ))}
        </div>
      </div>
      <div className="remove-control-stack">
        <AdjustmentSlider
          label="Size"
          value={props.healSettings.size}
          min={2}
          max={500}
          defaultValue={34}
          onChange={(size) => props.onHealSettingsChange({ ...props.healSettings, size })}
        />
        {props.healSettings.mode !== "remove" ? (
          <>
            <AdjustmentSlider
              label="Feather"
              value={props.healSettings.feather}
              min={0}
              max={100}
              defaultValue={72}
              onChange={(feather) => props.onHealSettingsChange({ ...props.healSettings, feather })}
            />
            <AdjustmentSlider
              label="Opacity"
              value={props.healSettings.opacity}
              min={0}
              max={100}
              defaultValue={100}
              onChange={(opacity) => props.onHealSettingsChange({ ...props.healSettings, opacity })}
            />
          </>
        ) : null}
        {props.healSettings.mode === "remove" ? (
          <div className="remove-ai-options" aria-label="Remove options">
            <label className="toggle-field" title="Requires a connected generative model; unavailable in this local build">
              <input type="checkbox" disabled />
              <span>Use generative AI</span>
              <Info size={12} aria-hidden="true" />
            </label>
            <label className="toggle-field" title="Object detection requires a connected model; unavailable in this local build">
              <input type="checkbox" disabled />
              <span>Detect objects</span>
            </label>
          </div>
        ) : null}
      </div>

      {activeSpot ? (
        <section className="remove-selected" aria-label="Selected repair">
          <div className="remove-selected__heading">
            <strong>Selected</strong>
            <div>
              <button type="button" disabled title="Repair refinement is unavailable" aria-label="Refine selected repair">
                <Brush size={14} />
              </button>
              <button type="button" title="Delete selected repair" aria-label="Delete selected repair" onClick={() => props.onRemoveHealSpot(activeSpot.id)}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <label className="field remove-fill-field">
            <span className="field__label">Fill</span>
            <select
              value={activeSpot.mode}
              aria-label="Selected repair fill"
              onChange={(event) => {
                props.onBeginEdit();
                props.onUpdateHealSpot(activeSpot.id, {
                  mode: event.target.value as HealSpot["mode"],
                });
                props.onCommitEdit();
              }}
            >
              <option value="remove">Content-Aware Remove</option>
              <option value="heal">Heal</option>
              <option value="clone">Clone</option>
            </select>
          </label>
          <AdjustmentSlider
            label="Opacity"
            value={activeSpot.opacity}
            min={0}
            max={100}
            defaultValue={100}
            onBegin={props.onBeginEdit}
            onCommit={props.onCommitEdit}
            onChange={(opacity) => props.onUpdateHealSpot(activeSpot.id, { opacity })}
          />
          <div className="remove-variation-row">
            <span>Variations</span>
            <button type="button" disabled aria-label="Previous variation">‹</button>
            <small>Unavailable</small>
            <button type="button" disabled aria-label="Next variation">›</button>
            <button type="button" disabled aria-label="More variation options">⋯</button>
          </div>
          <div className="remove-selected__actions">
            <button type="button" onClick={() => props.onRecenterHealSource(activeSpot.id)} title="Try another source (/) ">
              <LocateFixed size={13} /> Refresh source
            </button>
            <button type="button" disabled title="Requires a connected generative provider">Generate</button>
          </div>
        </section>
      ) : null}

      <div className="remove-display-controls">
        <label className="field remove-overlay-field">
          <span className="field__label">Tool Overlay</span>
          <select
            value={props.healOverlayMode}
            aria-label="Remove tool overlay"
            onChange={(event) => props.onHealOverlayModeChange(event.target.value as HealOverlayMode)}
          >
            <option value="auto">Auto</option>
            <option value="always">Always</option>
            <option value="selected">Selected</option>
            <option value="never">Never</option>
          </select>
        </label>
        <label className="toggle-field remove-visualize-toggle">
          <input
            type="checkbox"
            checked={props.visualizeSpots}
            onChange={(event) => props.onVisualizeSpotsChange(event.target.checked)}
          />
          <span>Visualize Spots</span>
        </label>
        <input
          className="remove-visualize-slider"
          type="range"
          min={0}
          max={100}
          value={props.visualizeSpotsThreshold}
          disabled={!props.visualizeSpots}
          aria-label="Visualize Spots threshold"
          onInput={(event) => props.onVisualizeSpotsThresholdChange(Number(event.currentTarget.value))}
        />
      </div>

      <div className="remove-footer-actions">
        <button type="button" disabled={!props.photo.edits.healSpots.length} onClick={props.onResetHealSpots}>Reset</button>
        <button type="button" onClick={() => {
          props.onActiveHealSpotChange(null);
          props.onCloseHeal();
        }}>Close</button>
      </div>

      <section className="remove-distraction-section">
        <strong>Distraction Removal</strong>
        {[
          ["Reflections", "Automatic reflection removal requires a connected model"],
          ["People", "Automatic people removal requires a connected model"],
          ["Dust", "Automatic dust detection requires a connected model"],
        ].map(([label, title]) => (
          <button key={label} type="button" disabled title={title}>
            <ChevronDown size={12} /> {label}
          </button>
        ))}
      </section>
    </div>
  );
}

function PresetsInspector({
  photo,
  onApplyPreset,
  onPreviewPreset,
}: Pick<InspectorProps, "photo" | "onApplyPreset" | "onPreviewPreset">) {
  const [search, setSearch] = useState("");
  const [collapsedPresetGroups, setCollapsedPresetGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const presets = BUILT_IN_PRESETS.filter((preset) =>
    `${preset.name} ${preset.group} ${preset.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const presetGroups = new Map<string, DevelopPreset[]>();
  for (const preset of presets) {
    const group = presetGroups.get(preset.group) ?? [];
    group.push(preset);
    presetGroups.set(preset.group, group);
  }
  const isFilteringPresets = Boolean(search.trim());
  const togglePresetGroup = (group: string) => {
    setCollapsedPresetGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  return (
    <>
      <div className="inspector-tool-heading">
        <div>
          <Sparkles size={17} />
          <strong>Presets</strong>
        </div>
        <span>{presets.length}</span>
      </div>
      <div className="preset-search inspector-preset-search">
        <input
          value={search}
          placeholder="Search presets"
          aria-label="Search presets"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="preset-list inspector-preset-list" aria-label="Preset groups">
        {[...presetGroups.entries()].map(([group, groupPresets]) => {
          const collapsed = !isFilteringPresets && collapsedPresetGroups.has(group);
          const groupId = `inspector-preset-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
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
              <div id={groupId} className="preset-group__items" hidden={collapsed}>
                {groupPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="preset-row"
                    onClick={() => {
                      onPreviewPreset?.(null);
                      onApplyPreset(preset);
                    }}
                    onPointerEnter={() => onPreviewPreset?.(preset)}
                    onPointerLeave={() => onPreviewPreset?.(null)}
                    onFocus={() => onPreviewPreset?.(preset)}
                    onBlur={() => onPreviewPreset?.(null)}
                    title={`${preset.description} Apply to ${photo.name}`}
                  >
                    <span className={`preset-swatch preset-swatch--${preset.id}`} />
                    <span>
                      <strong>{preset.name}</strong>
                      <small>{preset.group}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {!presets.length ? (
        <p className="sidebar-muted">No presets match that search.</p>
      ) : null}
    </>
  );
}

function VersionsInspector({
  snapshots,
  historyCount,
  onCreateSnapshot,
  onRestoreSnapshot,
  onResetEdits,
}: Pick<
  InspectorProps,
  | "snapshots"
  | "historyCount"
  | "onCreateSnapshot"
  | "onRestoreSnapshot"
  | "onResetEdits"
>) {
  return (
    <>
      <div className="inspector-tool-heading">
        <div>
          <History size={17} />
          <strong>Versions</strong>
        </div>
        <button
          type="button"
          className="button button--quiet"
          onClick={onCreateSnapshot}
        >
          <Plus size={13} />
          Create
        </button>
      </div>
      <Panel title="Named versions" defaultOpen>
        {snapshots.length ? (
          <div className="snapshot-list inspector-version-list">
            {[...snapshots].reverse().map((snapshot) => (
              <button
                key={snapshot.id}
                type="button"
                onClick={() => onRestoreSnapshot(snapshot)}
              >
                <span>{snapshot.label}</span>
                <time>
                  {new Date(snapshot.createdAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </button>
            ))}
          </div>
        ) : (
          <p className="sidebar-muted">
            Save a named version before trying a different direction.
          </p>
        )}
      </Panel>
      <Panel title="History" defaultOpen>
        <div className="history-summary">
          <span className={historyCount ? "is-live" : ""} />
          <div>
            <strong>
              {historyCount
                ? `${historyCount} ${historyCount === 1 ? "edit step" : "edit steps"}`
                : "Imported"}
            </strong>
            <small>Undo and redo remain non-destructive</small>
          </div>
        </div>
      </Panel>
      <button
        type="button"
        className="button button--quiet inspector-reset-edits"
        onClick={onResetEdits}
      >
        <RotateCcw size={14} />
        Reset all edits
      </button>
    </>
  );
}

function MetadataInspector({
  photo,
  onMetadataChange,
  onKeywordsChange,
  onColorLabelChange,
}: Pick<
  InspectorProps,
  | "photo"
  | "onMetadataChange"
  | "onKeywordsChange"
  | "onColorLabelChange"
>) {
  const metadata = photo.metadata;
  const rows = [
    ["File", photo.name],
    ["Dimensions", `${photo.width} × ${photo.height}`],
    ["Camera", metadata.camera ?? "—"],
    ["Lens", metadata.lens ?? "—"],
    ["Exposure", metadata.shutter ?? "—"],
    ["Aperture", metadata.aperture ? `f/${metadata.aperture}` : "—"],
    ["ISO", metadata.iso?.toString() ?? "—"],
    ["Focal length", metadata.focalLength ? `${metadata.focalLength} mm` : "—"],
    ["Captured", metadata.capturedAt ?? "—"],
    [
      "Location",
      metadata.latitude !== undefined && metadata.longitude !== undefined
        ? `${metadata.latitude.toFixed(5)}, ${metadata.longitude.toFixed(5)}`
        : "—",
    ],
  ];
  return (
    <>
      <div className="inspector-tool-heading">
        <div>
          <Info size={17} />
          <strong>Info</strong>
        </div>
      </div>
      <dl className="metadata-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {metadata.latitude !== undefined && metadata.longitude !== undefined ? (
        <div className="metadata-location-note">
          <p>
            Precise GPS is kept in this browser catalog and omitted from JSON
            backups.
          </p>
          <button
            type="button"
            onClick={() =>
              onMetadataChange({ latitude: undefined, longitude: undefined })
            }
          >
            Remove location from catalog copy
          </button>
        </div>
      ) : null}
      <div className="metadata-edit-fields">
        <label>
          <span>Caption</span>
          <textarea
            key={`${photo.id}-caption-${metadata.caption ?? ""}`}
            defaultValue={metadata.caption ?? ""}
            placeholder="Describe this photograph"
            onBlur={(event) => onMetadataChange({ caption: event.target.value })}
          />
        </label>
        <label>
          <span>Copyright</span>
          <input
            key={`${photo.id}-copyright-${metadata.copyright ?? ""}`}
            defaultValue={metadata.copyright ?? ""}
            placeholder="Copyright notice"
            onBlur={(event) => onMetadataChange({ copyright: event.target.value })}
          />
        </label>
        <label>
          <span>Keywords</span>
          <input
            key={`${photo.id}-keywords-${photo.keywords.join("|")}`}
            defaultValue={photo.keywords.join(", ")}
            placeholder="portrait, night, Toronto"
            onBlur={(event) =>
              onKeywordsChange(
                [...new Set(
                  event.target.value
                    .split(",")
                    .map((keyword) => keyword.trim())
                    .filter(Boolean),
                )],
              )
            }
          />
        </label>
        <label>
          <span>Color label</span>
          <select
            value={photo.colorLabel}
            onChange={(event) =>
              onColorLabelChange(event.target.value as ColorLabel)
            }
          >
            <option value="none">None</option>
            <option value="red">Red</option>
            <option value="yellow">Yellow</option>
            <option value="green">Green</option>
            <option value="blue">Blue</option>
            <option value="purple">Purple</option>
          </select>
        </label>
      </div>
    </>
  );
}

export default function RightInspector(props: InspectorProps) {
  const tools: { tool: EditorTool; label: string; icon: typeof Gauge }[] = [
    { tool: "edit", label: "Edit", icon: SlidersHorizontal },
    { tool: "presets", label: "Presets", icon: Sparkles },
    { tool: "crop", label: "Crop", icon: Crop },
    { tool: "heal", label: "Remove", icon: Bandage },
    { tool: "mask", label: "Mask", icon: CircleDashed },
    { tool: "versions", label: "Versions", icon: History },
    { tool: "metadata", label: "Info", icon: Info },
  ];

  return (
    <aside className="right-inspector">
      <button
        type="button"
        className={`histogram-button ${props.showClipping ? "is-active" : ""}`}
        aria-pressed={props.showClipping}
        onClick={props.onToggleClipping}
        title="Toggle clipping warnings (J)"
      >
        <Histogram data={props.histogram} clipping={props.showClipping} />
      </button>
      <div className="editor-tools">
        {tools.map(({ tool, label, icon }) => (
          <IconButton
            key={tool}
            icon={icon}
            label={label}
            active={props.tool === tool}
            onClick={() => props.onToolChange(tool)}
          />
        ))}
      </div>
      <div className="right-inspector__scroll">
        {props.tool === "edit" ? <EditInspector {...props} /> : null}
        {props.tool === "presets" ? (
          <PresetsInspector
            photo={props.photo}
            onApplyPreset={props.onApplyPreset}
            onPreviewPreset={props.onPreviewPreset}
          />
        ) : null}
        {props.tool === "crop" ? <CropInspector {...props} /> : null}
        {props.tool === "mask" ? <MaskInspector {...props} /> : null}
        {props.tool === "heal" ? <HealInspector {...props} /> : null}
        {props.tool === "metadata" ? (
          <MetadataInspector
            photo={props.photo}
            onMetadataChange={props.onMetadataChange}
            onKeywordsChange={props.onKeywordsChange}
            onColorLabelChange={props.onColorLabelChange}
          />
        ) : null}
        {props.tool === "versions" ? (
          <VersionsInspector
            snapshots={props.snapshots}
            historyCount={props.historyCount}
            onCreateSnapshot={props.onCreateSnapshot}
            onRestoreSnapshot={props.onRestoreSnapshot}
            onResetEdits={props.onResetEdits}
          />
        ) : null}
      </div>
      <div className="inspector-footer" aria-label="Develop settings actions">
        <button type="button" onClick={props.onPreviousSettings}>Previous</button>
        <button type="button" onClick={props.onResetEdits}>Reset</button>
        <button
          type="button"
          className="inspector-footer__sync"
          onClick={props.onSyncSettings}
          title={props.syncCount ? `Synchronize ${props.syncCount} selected photographs` : "Select multiple photographs to synchronize"}
        >
          Sync{props.syncCount ? ` (${props.syncCount})` : "…"}
        </button>
      </div>
    </aside>
  );
}
