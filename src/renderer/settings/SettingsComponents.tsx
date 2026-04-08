// =============================================================================
// Reusable settings form components. Ported from SettingsComponents.swift
// =============================================================================

import type { ReactNode } from 'react'

// -----------------------------------------------------------------------------
// SettingRow — label + control layout
// -----------------------------------------------------------------------------

interface SettingRowProps {
  label: string
  description?: string
  children: ReactNode
}

export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-subtle">
      <div className="flex flex-col">
        <span className="text-sm text-primary">{label}</span>
        {description && <span className="text-xs text-muted mt-0.5">{description}</span>}
      </div>
      <div className="flex-shrink-0 ml-4">{children}</div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Toggle switch
// -----------------------------------------------------------------------------

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
}

export function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        checked ? 'bg-focus-blue' : 'bg-surface-6'
      }`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// -----------------------------------------------------------------------------
// Text input
// -----------------------------------------------------------------------------

interface TextInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function TextInput({ value, onChange, placeholder }: TextInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-48 bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary placeholder:text-muted focus:border-focus-blue focus:outline-none"
    />
  )
}

// -----------------------------------------------------------------------------
// Number input with stepper
// -----------------------------------------------------------------------------

interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}

export function NumberInput({ value, onChange, min, max, step = 1 }: NumberInputProps) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (!isNaN(v)) {
          const clamped = Math.min(Math.max(v, min ?? -Infinity), max ?? Infinity)
          onChange(clamped)
        }
      }}
      min={min}
      max={max}
      step={step}
      className="w-20 bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary text-center focus:border-focus-blue focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
    />
  )
}

// -----------------------------------------------------------------------------
// Select dropdown
// -----------------------------------------------------------------------------

interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
}

export function Select({ value, onChange, options }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary focus:border-focus-blue focus:outline-none cursor-pointer"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} className="bg-surface-5 text-primary">
          {opt.label}
        </option>
      ))}
    </select>
  )
}

// -----------------------------------------------------------------------------
// Slider
// -----------------------------------------------------------------------------

interface SliderProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step: number
}

export function Slider({ value, onChange, min, max, step }: SliderProps) {
  return (
    <input
      type="range"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
      step={step}
      className="w-32 h-1.5 bg-surface-6 rounded-full appearance-none cursor-pointer accent-focus-blue [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-focus-blue"
    />
  )
}
