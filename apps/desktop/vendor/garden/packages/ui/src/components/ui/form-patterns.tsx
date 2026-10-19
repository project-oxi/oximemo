import { useId, type ComponentProps, type ReactNode } from "react"
import { cn } from "../../lib/utils"
import { Input } from "./input"

export interface FormFieldControlProps {
  id: string
  required?: boolean
  "aria-describedby"?: string
  "aria-invalid"?: true
  "aria-required"?: true
}

export interface FormFieldProps {
  id?: string
  label: string
  description?: string
  error?: string
  required?: boolean
  className?: string
  children: (controlProps: FormFieldControlProps) => ReactNode
}

/** Pass controlProps to the input so its label, help, and error remain connected. */
export function FormField({ id, label, description, error, required, children, className }: FormFieldProps) {
  const generated = useId()
  const controlId = id ?? generated
  const describedBy = [description && `${controlId}-help`, error && `${controlId}-error`].filter(Boolean).join(" ") || undefined
  return <div className={cn("g-form-field", className)}>
    <label htmlFor={controlId}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {children({ id: controlId, required: required || undefined, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required ? true : undefined })}
    {description && <p id={`${controlId}-help`} className="g-form-field-help">{description}</p>}
    {error && <p id={`${controlId}-error`} className="g-form-field-error" role="alert">{error}</p>}
  </div>
}

export interface SliderProps extends Omit<ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange" | "children"> {
  label: string
  value: number
  onValueChange: (value: number) => void
  formatValue?: (value: number) => string
}

/** Native range semantics provide pointer, touch, and platform keyboard behavior. */
export function Slider({ label, value, onValueChange, formatValue = String, id, className, min = 0, max = 100, step = 1, ...props }: SliderProps) {
  const generated = useId()
  const controlId = id ?? generated
  return <div className={cn("g-slider", className)}>
    <div className="g-slider-label"><label htmlFor={controlId}>{label}</label><output htmlFor={controlId}>{formatValue(value)}</output></div>
    <input {...props} id={controlId} type="range" min={min} max={max} step={step} value={value} aria-valuetext={formatValue(value)} onChange={event => onValueChange(event.currentTarget.valueAsNumber)} />
  </div>
}

export interface InputOTPProps extends Omit<ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange" | "maxLength" | "pattern" | "children"> {
  label: string
  value: string
  onValueChange: (value: string) => void
  length?: number
}

/** One real input preserves paste, autofill, and screen-reader editing behavior. */
export function InputOTP({ label, value, onValueChange, length = 6, className, id, onPaste, ...props }: InputOTPProps) {
  const generated = useId()
  const controlId = id ?? generated
  const digits = Number.isFinite(length) ? Math.min(12, Math.max(1, Math.floor(length))) : 6
  return <div className={cn("g-input-otp", className)}>
    <label htmlFor={controlId}>{label}</label>
    <Input {...props} id={controlId} type="text" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={value} maxLength={digits} pattern={`[0-9]{${digits}}`} onChange={event => onValueChange(event.currentTarget.value.replace(/[^0-9]/g, "").slice(0, digits))} onPaste={event => {
      onPaste?.(event)
      if (event.defaultPrevented || props.readOnly) return
      event.preventDefault()
      onValueChange(event.clipboardData.getData("text").replace(/[^0-9]/g, "").slice(0, digits))
    }} />
  </div>
}

export interface ButtonGroupProps extends ComponentProps<"div"> {
  label: string
  orientation?: "horizontal" | "vertical"
}

export function ButtonGroup({ label, orientation = "horizontal", className, children, ...props }: ButtonGroupProps) {
  return <div {...props} role="group" aria-label={label} className={cn("g-button-group", className)} data-orientation={orientation}>{children}</div>
}
