import { useRef, useState } from "react";
import type { LensCorrections, PhotoMetadata } from "../types";
import { AdjustmentSlider, Panel, SegmentedControl } from "./ui";
import "./LensCorrectionsPanel.css";

type LensCorrectionsPanelProps = {
  value: LensCorrections;
  metadata: PhotoMetadata;
  onBegin: () => void;
  onCommit: () => void;
  onChange: (value: LensCorrections) => void;
};

type PanelTab = "profile" | "manual";

const CAMERA_MAKES = [
  "Canon",
  "Fujifilm",
  "Hasselblad",
  "Leica",
  "Nikon",
  "Olympus",
  "Panasonic",
  "Pentax",
  "Phase One",
  "Sigma",
  "Sony",
] as const;

function inferMake(metadata: PhotoMetadata) {
  const description = `${metadata.camera ?? ""} ${metadata.lens ?? ""}`.trim();
  const make = CAMERA_MAKES.find((candidate) =>
    description.toLocaleLowerCase().includes(candidate.toLocaleLowerCase()),
  );

  if (make) return make;
  return description.split(/\s+/)[0] || "Unknown";
}

function ProfileValue({ children }: { children: string }) {
  return (
    <output className="lens-corrections__profile-value" title={children}>
      <span>{children}</span>
      <span aria-hidden="true" className="lens-corrections__profile-chevron">
        ▾
      </span>
    </output>
  );
}

function HueRange({
  color,
  low,
  high,
  onLowChange,
  onHighChange,
  onBegin,
  onCommit,
}: {
  color: "purple" | "green";
  low: number;
  high: number;
  onLowChange: (value: number) => void;
  onHighChange: (value: number) => void;
  onBegin: () => void;
  onCommit: () => void;
}) {
  const interaction = useRef({ low: false, high: false });
  const label = color === "purple" ? "Purple" : "Green";

  const begin = (handle: "low" | "high") => {
    if (interaction.current[handle]) return;
    interaction.current[handle] = true;
    onBegin();
  };

  const commit = (handle: "low" | "high") => {
    if (!interaction.current[handle]) return;
    interaction.current[handle] = false;
    onCommit();
  };

  return (
    <div className="lens-corrections__hue-range">
      <div className="lens-corrections__hue-heading">
        <span>Hue</span>
        <output aria-label={`${label} hue range`}>
          {Math.round(low)} / {Math.round(high)}
        </output>
      </div>
      <div className={`lens-corrections__hue-band is-${color}`}>
        <input
          aria-label={`${label} hue lower bound`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={low}
          onPointerDown={() => begin("low")}
          onPointerUp={() => commit("low")}
          onPointerCancel={() => commit("low")}
          onBlur={() => commit("low")}
          onKeyDown={(event) => {
            if (
              event.key.startsWith("Arrow") ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              begin("low");
            }
          }}
          onKeyUp={() => commit("low")}
          onChange={(event) =>
            onLowChange(Math.min(Number(event.currentTarget.value), high))
          }
        />
        <input
          aria-label={`${label} hue upper bound`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={high}
          onPointerDown={() => begin("high")}
          onPointerUp={() => commit("high")}
          onPointerCancel={() => commit("high")}
          onBlur={() => commit("high")}
          onKeyDown={(event) => {
            if (
              event.key.startsWith("Arrow") ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              begin("high");
            }
          }}
          onKeyUp={() => commit("high")}
          onChange={(event) =>
            onHighChange(Math.max(Number(event.currentTarget.value), low))
          }
        />
      </div>
    </div>
  );
}

export function LensCorrectionsPanel({
  value,
  metadata,
  onBegin,
  onCommit,
  onChange,
}: LensCorrectionsPanelProps) {
  const [tab, setTab] = useState<PanelTab>("profile");
  const make = inferMake(metadata);
  const model = metadata.lens ?? "Unknown lens";
  const profile = metadata.lens ? "Generic browser correction" : "None";

  const update = <Key extends keyof LensCorrections>(
    key: Key,
    nextValue: LensCorrections[Key],
  ) => onChange({ ...value, [key]: nextValue });

  const commitImmediate = <Key extends keyof LensCorrections>(
    key: Key,
    nextValue: LensCorrections[Key],
  ) => {
    onBegin();
    update(key, nextValue);
    onCommit();
  };

  return (
    <Panel title="Lens Corrections" className="lens-corrections-panel">
      <div className="lens-corrections__tabs">
        <SegmentedControl
          label="Lens Corrections view"
          value={tab}
          options={[
            { value: "profile", label: "Profile" },
            { value: "manual", label: "Manual" },
          ]}
          onChange={setTab}
        />
      </div>

      {tab === "profile" ? (
        <div className="lens-corrections__content">
          <div className="lens-corrections__checks">
            <label className="lens-corrections__check">
              <input
                type="checkbox"
                checked={value.removeChromaticAberration}
                onChange={(event) =>
                  commitImmediate(
                    "removeChromaticAberration",
                    event.currentTarget.checked,
                  )
                }
              />
              <span>Remove Chromatic Aberration</span>
            </label>
            <label className="lens-corrections__check">
              <input
                type="checkbox"
                checked={value.enableProfileCorrections}
                onChange={(event) =>
                  commitImmediate(
                    "enableProfileCorrections",
                    event.currentTarget.checked,
                  )
                }
              />
              <span>Enable Profile Corrections</span>
            </label>
          </div>

          <label className="lens-corrections__select-row">
            <span>Setup</span>
            <select
              aria-label="Lens profile setup"
              value={value.setup}
              disabled={!value.enableProfileCorrections}
              onChange={(event) =>
                commitImmediate(
                  "setup",
                  event.currentTarget.value as LensCorrections["setup"],
                )
              }
            >
              <option value="default">Default</option>
              <option value="auto">Auto</option>
              <option value="custom">Custom</option>
            </select>
          </label>

          <section
            className={`lens-corrections__section lens-corrections__profile ${
              value.enableProfileCorrections ? "" : "is-disabled"
            }`}
            aria-label="Lens profile"
            aria-disabled={!value.enableProfileCorrections}
          >
            <h4>Lens Profile</h4>
            <div className="lens-corrections__profile-grid">
              <span>Make</span>
              <ProfileValue>{make}</ProfileValue>
              <span>Model</span>
              <ProfileValue>{model}</ProfileValue>
              <span>Profile</span>
              <ProfileValue>{profile}</ProfileValue>
            </div>
            <p className="lens-corrections__profile-status">
              {metadata.lens
                ? "Generic profile correction applied."
                : "No matching lens profile was found."}
            </p>
          </section>
        </div>
      ) : (
        <div className="lens-corrections__content lens-corrections__manual">
          <section className="lens-corrections__section" aria-label="Distortion">
            <h4>Distortion</h4>
            <AdjustmentSlider
              label="Amount"
              value={value.distortion}
              min={-100}
              max={100}
              defaultValue={0}
              onBegin={onBegin}
              onCommit={onCommit}
              onChange={(nextValue) => update("distortion", nextValue)}
            />
          </section>

          <section className="lens-corrections__section" aria-label="Vignetting">
            <h4>Vignetting</h4>
            <div className="adjustment-list">
              <AdjustmentSlider
                label="Amount"
                value={value.vignette}
                min={-100}
                max={100}
                defaultValue={0}
                onBegin={onBegin}
                onCommit={onCommit}
                onChange={(nextValue) => update("vignette", nextValue)}
              />
              <AdjustmentSlider
                label="Midpoint"
                value={value.midpoint}
                min={0}
                max={100}
                defaultValue={50}
                onBegin={onBegin}
                onCommit={onCommit}
                onChange={(nextValue) => update("midpoint", nextValue)}
              />
            </div>
          </section>

          <section className="lens-corrections__section" aria-label="Defringe">
            <h4>Defringe</h4>
            <div className="lens-corrections__defringe-group">
              <AdjustmentSlider
                label="Purple Amount"
                value={value.defringePurpleAmount}
                min={0}
                max={20}
                defaultValue={0}
                onBegin={onBegin}
                onCommit={onCommit}
                onChange={(nextValue) =>
                  update("defringePurpleAmount", nextValue)
                }
              />
              <HueRange
                color="purple"
                low={value.defringePurpleHueLow}
                high={value.defringePurpleHueHigh}
                onBegin={onBegin}
                onCommit={onCommit}
                onLowChange={(nextValue) =>
                  update("defringePurpleHueLow", nextValue)
                }
                onHighChange={(nextValue) =>
                  update("defringePurpleHueHigh", nextValue)
                }
              />
            </div>
            <div className="lens-corrections__defringe-group">
              <AdjustmentSlider
                label="Green Amount"
                value={value.defringeGreenAmount}
                min={0}
                max={20}
                defaultValue={0}
                onBegin={onBegin}
                onCommit={onCommit}
                onChange={(nextValue) =>
                  update("defringeGreenAmount", nextValue)
                }
              />
              <HueRange
                color="green"
                low={value.defringeGreenHueLow}
                high={value.defringeGreenHueHigh}
                onBegin={onBegin}
                onCommit={onCommit}
                onLowChange={(nextValue) =>
                  update("defringeGreenHueLow", nextValue)
                }
                onHighChange={(nextValue) =>
                  update("defringeGreenHueHigh", nextValue)
                }
              />
            </div>
          </section>
        </div>
      )}
    </Panel>
  );
}
