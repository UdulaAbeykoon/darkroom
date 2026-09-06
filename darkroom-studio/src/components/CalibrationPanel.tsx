import { useId } from "react";
import { RotateCcw } from "lucide-react";
import type { CalibrationAdjustments } from "../types";
import { AdjustmentSlider, Panel } from "./ui";
import "./CalibrationPanel.css";

export interface CalibrationPanelProps {
  value: CalibrationAdjustments;
  onBegin: () => void;
  onCommit: () => void;
  onChange: (value: CalibrationAdjustments) => void;
}

type NumericCalibrationKey = Exclude<keyof CalibrationAdjustments, "processVersion">;

const DEFAULT_CALIBRATION: CalibrationAdjustments = {
  processVersion: "6",
  shadowsTint: 0,
  redPrimaryHue: 0,
  redPrimarySaturation: 0,
  greenPrimaryHue: 0,
  greenPrimarySaturation: 0,
  bluePrimaryHue: 0,
  bluePrimarySaturation: 0,
};

const PRIMARY_GROUPS = [
  {
    key: "red",
    title: "Red Primary",
    hue: "redPrimaryHue",
    saturation: "redPrimarySaturation",
  },
  {
    key: "green",
    title: "Green Primary",
    hue: "greenPrimaryHue",
    saturation: "greenPrimarySaturation",
  },
  {
    key: "blue",
    title: "Blue Primary",
    hue: "bluePrimaryHue",
    saturation: "bluePrimarySaturation",
  },
] as const satisfies ReadonlyArray<{
  key: "red" | "green" | "blue";
  title: string;
  hue: NumericCalibrationKey;
  saturation: NumericCalibrationKey;
}>;

function isAtDefault(value: CalibrationAdjustments) {
  return (Object.keys(DEFAULT_CALIBRATION) as (keyof CalibrationAdjustments)[]).every(
    (key) => value[key] === DEFAULT_CALIBRATION[key],
  );
}

/**
 * Camera-primary calibration controls. The component is
 * controlled so callers can include every interaction in their edit history.
 */
export function CalibrationPanel({
  value,
  onBegin,
  onCommit,
  onChange,
}: CalibrationPanelProps) {
  const headingId = useId();
  const atDefault = isAtDefault(value);

  const updateNumber = (key: NumericCalibrationKey, nextValue: number) => {
    onChange({ ...value, [key]: nextValue });
  };

  const reset = () => {
    if (atDefault) return;
    onBegin();
    onChange({ ...DEFAULT_CALIBRATION });
    onCommit();
  };

  return (
    <Panel
      title="Calibration"
      className="calibration-panel"
      action={
        <button
          type="button"
          className="panel-reset calibration-panel__reset"
          aria-label="Reset Calibration"
          title="Reset Calibration"
          disabled={atDefault}
          onClick={reset}
        >
          <RotateCcw aria-hidden="true" size={12} strokeWidth={1.8} />
        </button>
      }
    >
      <div className="calibration-panel__process">
        <label htmlFor={`${headingId}-process`}>Process</label>
        <select
          id={`${headingId}-process`}
          value={value.processVersion}
          onChange={(event) => {
            onBegin();
            onChange({
              ...value,
              processVersion: event.currentTarget.value as CalibrationAdjustments["processVersion"],
            });
            onCommit();
          }}
        >
          <option value="6">Version 6 (Current)</option>
        </select>
      </div>

      <div
        className="calibration-panel__group calibration-panel__group--shadows"
        role="group"
        aria-labelledby={`${headingId}-shadows`}
      >
        <h3 id={`${headingId}-shadows`}>Shadows</h3>
        <AdjustmentSlider
          label="Tint"
          value={value.shadowsTint}
          min={-100}
          max={100}
          defaultValue={0}
          onBegin={onBegin}
          onCommit={onCommit}
          onChange={(nextValue) => updateNumber("shadowsTint", nextValue)}
        />
      </div>

      {PRIMARY_GROUPS.map((group) => (
        <div
          key={group.key}
          className={`calibration-panel__group calibration-panel__group--${group.key}`}
          role="group"
          aria-labelledby={`${headingId}-${group.key}`}
        >
          <h3 id={`${headingId}-${group.key}`}>{group.title}</h3>
          <div className="adjustment-list">
            <AdjustmentSlider
              label="Hue"
              value={value[group.hue]}
              min={-100}
              max={100}
              defaultValue={0}
              onBegin={onBegin}
              onCommit={onCommit}
              onChange={(nextValue) => updateNumber(group.hue, nextValue)}
            />
            <AdjustmentSlider
              label="Saturation"
              value={value[group.saturation]}
              min={-100}
              max={100}
              defaultValue={0}
              onBegin={onBegin}
              onCommit={onCommit}
              onChange={(nextValue) => updateNumber(group.saturation, nextValue)}
            />
          </div>
        </div>
      ))}
    </Panel>
  );
}

export default CalibrationPanel;
