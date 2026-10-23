import { useId, useState } from 'react'
import { Icon } from '../icons.jsx'

export function PasswordField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  disabled,
  inputClassName = 'field',
}) {
  const [revealed, setRevealed] = useState(false)
  const inputId = useId()

  return (
    <label className="password-field">
      <span className="label">
        {label}
        {hint ? <span className="muted-text"> {hint}</span> : null}
      </span>
      <div className="password-field-input">
        <input
          id={inputId}
          className={inputClassName}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          disabled={disabled}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setRevealed((shown) => !shown)}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          aria-controls={inputId}
          aria-pressed={revealed}
          disabled={disabled}
        >
          {revealed ? <Icon.EyeOff /> : <Icon.Eye />}
        </button>
      </div>
    </label>
  )
}
