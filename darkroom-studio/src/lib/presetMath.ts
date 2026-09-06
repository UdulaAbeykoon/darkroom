import { cloneEditState } from "../defaults";
import type {
  DevelopPreset,
  EditState,
  GlobalAdjustments,
  HslChannel,
  HueChannel,
} from "../types";

const clampAmount = (amount: number) =>
  Math.min(200, Math.max(0, Number.isFinite(amount) ? amount : 100));

const mix = (from: number, to: number, factor: number) =>
  from + (to - from) * factor;

/** Applies a preset relative to a stable base edit through the Amount control. */
export function applyPresetAtAmount(
  base: EditState,
  preset: DevelopPreset,
  amount: number,
): EditState {
  const normalizedAmount = clampAmount(amount);
  if (normalizedAmount === 0) return cloneEditState(base);
  const factor = normalizedAmount / 100;
  const next = cloneEditState(base);

  for (const [key, target] of Object.entries(preset.adjustments) as [
    keyof GlobalAdjustments,
    number | undefined,
  ][]) {
    if (typeof target !== "number") continue;
    next.global[key] = mix(base.global[key], target, factor);
  }

  if (preset.hsl) {
    for (const [channel, target] of Object.entries(preset.hsl) as [
      HueChannel,
      HslChannel | undefined,
    ][]) {
      if (!target) continue;
      next.hsl[channel] = {
        hue: mix(base.hsl[channel].hue, target.hue, factor),
        saturation: mix(
          base.hsl[channel].saturation,
          target.saturation,
          factor,
        ),
        luminance: mix(
          base.hsl[channel].luminance,
          target.luminance,
          factor,
        ),
      };
    }
  }

  if (preset.curve) {
    if (normalizedAmount === 100) {
      next.curve = structuredClone(preset.curve);
    } else {
      next.curve = preset.curve.map((target, index) => {
        const source = base.curve[index] ?? target;
        return {
          x: mix(source.x, target.x, factor),
          y: mix(source.y, target.y, factor),
        };
      });
    }
  }

  return next;
}
