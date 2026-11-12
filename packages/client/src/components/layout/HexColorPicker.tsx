/**
 * @fileoverview Hex-choosable GUI color palette popover component.
 * Allows users to choose from rich curated palettes, enter arbitrary hex codes,
 * or interact with the native GUI color wheel.
 */

import React, { useState, useEffect } from 'react';
import { Pipette, Check } from 'lucide-react';

/**
 * Validates and normalizes 3-char or 6-char hex strings into uppercase '#RRGGBB'.
 * Returns null if the input is not a valid hexadecimal color.
 */
export function normalizeHexColor(input: string): string | null {
  const trimmed = input.trim();
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
    return `#${hex.toUpperCase()}`;
  }
  if (/^[0-9A-Fa-f]{3}$/.test(hex)) {
    const full = hex
      .split('')
      .map((c) => c + c)
      .join('');
    return `#${full.toUpperCase()}`;
  }
  return null;
}

/** Converts HSL (h in 0..360, s in 0..100, l in 0..100) to uppercase hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const normL = l / 100;
  const a = (s * Math.min(normL, 1 - normL)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = normL - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/** Extracts hue angle (0..360) from hex color string. */
export function hexToHue(hexStr: string): number {
  const norm = normalizeHexColor(hexStr);
  if (!norm) return 210;
  const r = parseInt(norm.slice(1, 3), 16) / 255;
  const g = parseInt(norm.slice(3, 5), 16) / 255;
  const b = parseInt(norm.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 210;
  let h = 0;
  if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

export const EXTENDED_PALETTE_SWATCHES = [
  '#000000',
  '#334155',
  '#64748B',
  '#94A3B8',
  '#CBD5E1',
  '#FFFFFF',
  '#DC2626',
  '#EF4444',
  '#F87171',
  '#EA580C',
  '#F97316',
  '#FB923C',
  '#D97706',
  '#F59E0B',
  '#FBBF24',
  '#CA8A04',
  '#EAB308',
  '#FDE047',
  '#16A34A',
  '#22C55E',
  '#4ADE80',
  '#059669',
  '#10B981',
  '#34D399',
  '#0D9488',
  '#14B8A6',
  '#2DD4BF',
  '#0891B2',
  '#06B6D4',
  '#22D3EE',
  '#2563EB',
  '#3B82F6',
  '#60A5FA',
  '#4F46E5',
  '#6366F1',
  '#818CF8',
  '#7C3AED',
  '#8B5CF6',
  '#A78BFA',
  '#9333EA',
  '#C026D3',
  '#E879F9',
  '#DB2777',
  '#EC4899',
  '#F472B6',
];

export const EXTENDED_TINT_SWATCHES = [
  '#FFFFFF',
  '#F8FAFC',
  '#F1F5F9',
  '#E2E8F0',
  '#FEE2E2',
  '#FFEDD5',
  '#FEF3C7',
  '#FEF9C3',
  '#ECFCCB',
  '#DCFCE7',
  '#D1FAE5',
  '#CCFBF1',
  '#CFFAFE',
  '#E0F2FE',
  '#DBEAFE',
  '#E0E7FF',
  '#EDE9FE',
  '#F3E8FF',
  '#FAE8FF',
  '#FCE7F3',
  '#FFE4E6',
];

export interface HexColorPickerProps {
  label: string;
  currentColor: string | null;
  onChangeColor: (hex: string) => void;
  onClearColor?: () => void;
  canClear?: boolean;
  clearLabel?: string;
  showTints?: boolean;
  onClose?: () => void;
}

export const HexColorPicker: React.FC<HexColorPickerProps> = ({
  label,
  currentColor,
  onChangeColor,
  onClearColor,
  canClear = false,
  clearLabel = 'No Fill',
  showTints = false,
  onClose,
}) => {
  const [draftInput, setDraftInput] = useState<string>(currentColor ?? '');
  const [hue, setHue] = useState<number>(() => hexToHue(currentColor ?? '#18A0FB'));

  // Keep draft text and hue synced with external color updates
  useEffect(() => {
    setDraftInput(currentColor ?? '');
    if (currentColor) {
      setHue(hexToHue(currentColor));
    }
  }, [currentColor]);

  const cleanHex = draftInput.trim().startsWith('#')
    ? draftInput.trim().slice(1)
    : draftInput.trim();
  const validHex = normalizeHexColor(draftInput);
  const displayColor = validHex ?? currentColor ?? '#18A0FB';

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraftInput(raw);
    const normalized = normalizeHexColor(raw);
    if (normalized) {
      onChangeColor(normalized);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const normalized = normalizeHexColor(draftInput);
      if (normalized) {
        onChangeColor(normalized);
        onClose?.();
      }
    } else if (e.key === 'Escape') {
      onClose?.();
    }
  };

  const handleSelectSwatch = (hex: string) => {
    setDraftInput(hex);
    onChangeColor(hex);
  };

  return (
    <div
      data-property-bar="true"
      className="flex flex-col gap-2.5 w-64 p-3 rounded-xl border border-slate-700/90 bg-slate-900/98 shadow-2xl backdrop-blur-xl text-slate-200 select-none"
    >
      {/* Header with Title and Optional Clear button */}
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        <span>{label}</span>
        {canClear && onClearColor && (
          <button
            type="button"
            onClick={() => {
              onClearColor();
              onClose?.();
            }}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize transition ${
              !currentColor
                ? 'bg-blue-600/30 text-blue-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {clearLabel}
          </button>
        )}
      </div>

      {/* Hex Choosable GUI Picker Row */}
      <div className="flex items-center gap-2 rounded-lg border border-slate-700/90 bg-slate-800/80 px-2 py-1.5 shadow-inner">
        {/* Visual Swatch & Native Color Picker Trigger */}
        <label
          className="relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-slate-600 shadow-sm overflow-hidden shrink-0"
          title="Click to open system GUI color picker"
        >
          <span className="absolute inset-0" style={{ backgroundColor: displayColor }} />
          <Pipette className="relative z-10 h-3 w-3 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] opacity-80 hover:opacity-100 transition" />
          <input
            type="color"
            aria-label="System color picker"
            value={validHex || '#18A0FB'}
            onChange={(e) => {
              const val = e.target.value.toUpperCase();
              setDraftInput(val);
              onChangeColor(val);
            }}
            className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
          />
        </label>

        {/* Hex Text Field */}
        <div className="flex flex-1 items-center gap-0.5 font-mono text-xs">
          <span className="text-slate-400 font-bold select-none">#</span>
          <input
            type="text"
            value={cleanHex}
            maxLength={6}
            placeholder="HEX"
            onChange={handleTextChange}
            onKeyDown={handleInputKeyDown}
            className="w-full bg-transparent p-0 font-mono text-xs text-slate-100 uppercase focus:outline-none placeholder-slate-500"
          />
        </div>

        {validHex && (
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400"
            title="Valid hex color"
          >
            <Check className="h-2.5 w-2.5" />
          </span>
        )}
      </div>

      {/* GUI Spectrum Hue Slider */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-[10px] font-medium text-slate-400">
          <span>Spectrum Hue Slider</span>
          <span className="font-mono text-[10px] text-slate-400">{hue}°</span>
        </div>
        <input
          type="range"
          min="0"
          max="360"
          value={hue}
          aria-label="Spectrum Hue Slider"
          onChange={(e) => {
            const h = Number(e.target.value);
            setHue(h);
            const hex = hslToHex(h, 85, 48);
            setDraftInput(hex);
            onChangeColor(hex);
          }}
          className="h-2.5 w-full cursor-pointer appearance-none rounded-full accent-white"
          style={{
            background:
              'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
          }}
        />
      </div>

      {/* Tints Grid (if enabled) */}
      {showTints && (
        <div>
          <div className="mb-1 text-[10px] font-medium tracking-wide text-slate-400">
            Soft Tints & Pastels
          </div>
          <div className="grid grid-cols-7 gap-1">
            {EXTENDED_TINT_SWATCHES.map((hex) => {
              const active = currentColor?.toUpperCase() === hex.toUpperCase();
              return (
                <button
                  key={`tint-${hex}`}
                  type="button"
                  onClick={() => handleSelectSwatch(hex)}
                  style={{ backgroundColor: hex }}
                  title={`Tint: ${hex}`}
                  className={`h-5 w-5 rounded-md border border-slate-600 transition ${
                    active
                      ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-slate-900 scale-110 z-10'
                      : 'hover:scale-110'
                  }`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Curated Extended Palette Grid */}
      <div>
        <div className="mb-1 text-[10px] font-medium tracking-wide text-slate-400">
          Curated Palette
        </div>
        <div className="grid grid-cols-9 gap-1">
          {EXTENDED_PALETTE_SWATCHES.map((hex) => {
            const active = currentColor?.toUpperCase() === hex.toUpperCase();
            return (
              <button
                key={`palette-${hex}`}
                type="button"
                onClick={() => handleSelectSwatch(hex)}
                style={{ backgroundColor: hex }}
                title={`Color: ${hex}`}
                className={`h-5 w-5 rounded-md border border-slate-600 transition ${
                  active
                    ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-slate-900 scale-110 z-10'
                    : 'hover:scale-110'
                }`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};
