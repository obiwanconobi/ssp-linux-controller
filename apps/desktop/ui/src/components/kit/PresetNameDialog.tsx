import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  MAX_PRESET_NAME_BYTES,
  matchingPresetName,
  presetNameBytes,
  presetNameError,
} from '../../lib/presetNames';

interface PresetNameDialogProps {
  open: boolean;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  names: string[];
  excludeName?: string;
  disabled?: boolean;
  /** Allow an existing name so a save can overwrite it. */
  allowExisting?: boolean;
  nameLabel?: string;
  namePlaceholder?: string;
  validate?: (name: string) => string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => boolean | void | Promise<boolean | void>;
}

export const PresetNameDialog = ({
  open,
  title,
  description,
  initialName,
  submitLabel,
  names,
  excludeName,
  disabled = false,
  allowExisting = false,
  nameLabel = 'Patch name',
  namePlaceholder = 'Patch name',
  validate = presetNameError,
  onOpenChange,
  onSubmit,
}: PresetNameDialogProps) => {
  const [value, setValue] = useState(initialName);
  const [touched, setTouched] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialName);
      setTouched(false);
    }
  }, [initialName, open]);

  const trimmed = value.trim();
  const problem = validate(trimmed);
  const duplicate = matchingPresetName(names, trimmed, excludeName);
  const blocked =
    Boolean(problem) || (Boolean(duplicate) && !allowExisting) || disabled;
  const showProblem = touched && problem;
  const showDuplicate = Boolean(
    !problem && duplicate && (touched || allowExisting),
  );
  const showOverwrite = Boolean(showDuplicate && allowExisting);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameInput.current?.focus();
            nameInput.current?.select();
          }}
        >
          <div className="dialog-head">
            <div>
              <Dialog.Title className="dialog-title">{title}</Dialog.Title>
              <Dialog.Description className="hint">{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label={`Close ${title.toLowerCase()} dialog`}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (blocked) return;
              const result = await onSubmit(trimmed);
              if (result !== false) onOpenChange(false);
            }}
          >
            <div className="dialog-body">
              <label className="field-label" htmlFor="preset-name">
                {nameLabel}
                <span className="mono">
                  {presetNameBytes(value)} / {MAX_PRESET_NAME_BYTES}
                </span>
              </label>
              <input
                ref={nameInput}
                id="preset-name"
                className="input input--mono"
                autoFocus
                value={value}
                placeholder={namePlaceholder}
                onChange={(event) => {
                  setValue(event.target.value);
                  setTouched(true);
                }}
                onFocus={(event) => event.currentTarget.select()}
              />
              {showProblem && (
                <p className="preflight__warning preflight__warning--error" role="alert">
                  <AlertTriangle size={12} aria-hidden="true" /> {problem}
                </p>
              )}
              {showDuplicate && showOverwrite && (
                <p className="preflight__warning">
                  <AlertTriangle size={12} aria-hidden="true" />Saving will overwrite “
                  {duplicate}”.
                </p>
              )}
              {showDuplicate && !showOverwrite && (
                <p className="preflight__warning preflight__warning--error" role="alert">
                  <AlertTriangle size={12} aria-hidden="true" />A patch named “{duplicate}”
                  already exists.
                </p>
              )}
            </div>
            <div className="dialog-foot">
              <Dialog.Close asChild>
                <button type="button" className="btn">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn--primary" disabled={blocked}>
                {showOverwrite ? 'Overwrite' : submitLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
