import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  allowOverwrite?: boolean;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => boolean | void;
}

export const PresetNameDialog = ({
  open,
  title,
  description,
  initialName,
  submitLabel,
  names,
  excludeName,
  allowOverwrite = false,
  disabled = false,
  onOpenChange,
  onSubmit,
}: PresetNameDialogProps) => {
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    if (open) setValue(initialName);
  }, [initialName, open]);

  const trimmed = value.trim();
  const problem = presetNameError(trimmed);
  const duplicate = matchingPresetName(names, trimmed, excludeName);
  const blocked = Boolean(problem) || Boolean(duplicate && !allowOverwrite) || disabled;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
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
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked) return;
              const result = onSubmit(trimmed);
              if (result !== false) onOpenChange(false);
            }}
          >
            <div className="dialog-body">
              <label className="field-label" htmlFor="preset-name">
                Patch name
                <span className="mono">
                  {presetNameBytes(value)} / {MAX_PRESET_NAME_BYTES}
                </span>
              </label>
              <input
                id="preset-name"
                className="input input--mono"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
              />
              {problem && (
                <p className="preflight__warning preflight__warning--error" role="alert">
                  <AlertTriangle size={12} aria-hidden="true" /> {problem}
                </p>
              )}
              {!problem && duplicate && (
                <p
                  className={`preflight__warning${allowOverwrite ? '' : ' preflight__warning--error'}`}
                  role={allowOverwrite ? undefined : 'alert'}
                >
                  <AlertTriangle size={12} aria-hidden="true" />
                  {allowOverwrite
                    ? `A patch named “${duplicate}” already exists and will be overwritten.`
                    : `A patch named “${duplicate}” already exists.`}
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
                {submitLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
