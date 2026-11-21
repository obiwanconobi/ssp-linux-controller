import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';

const SHORTCUTS = [
  ['1 – 6', 'Switch Board, Amp room, Global EQ, Library, Settings, Stage'],
  ['Ctrl / ⌘ + K', 'Command palette'],
  ['[ / ]', 'Previous / next preset'],
  ['← / →', 'Select previous / next block'],
  ['Space', 'Bypass the selected block'],
  ['Enter', 'Open the selected block in focus mode'],
  ['Esc', 'Back one level; close overlay or focus'],
  ['T', 'Toggle the tuner deck'],
  ['Ctrl / ⌘ + S', 'Save the current preset'],
  ['Ctrl / ⌘ + Z / Shift+Z', 'Undo / redo the local edit buffer'],
  ['Shift + drag', 'Fine adjustment on knobs and sliders'],
  ['Home / End', 'Knob to minimum / maximum'],
  ['Double-click', 'Reset a knob to its device default'],
  ['?', 'Open this sheet'],
];

export const ShortcutsDialog = () => {
  const open = useAppStore((state) => state.shortcutsOpen);
  const setOpen = useAppStore((state) => state.setShortcutsOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content shortcuts-dialog" aria-describedby={undefined}>
          <header className="dialog-head">
            <div>
              <Dialog.Title className="dialog-title">Keyboard & gestures</Dialog.Title>
              <p className="hint">
                Every pointer action has a keyboard path. Focus follows the signal chain.
              </p>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close shortcuts">
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>
          <div className="dialog-body">
            <dl className="shortcut-list">
              {SHORTCUTS.map(([keys, action]) => (
                <div key={keys} className="shortcut-row">
                  <dt>
                    {keys.split(' + ').map((part, index) => (
                      <span key={`${keys}-${part}-${index}`}>
                        {index > 0 && ' + '}
                        <span className="kbd">{part}</span>
                      </span>
                    ))}
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
            <div className="shortcut-note">
              <span className="kbd">Shift</span>
              <span>fine adjustment</span>
              <span className="kbd">Dbl-click</span>
              <span>reset knob</span>
              <span className="kbd">Space</span>
              <span>bypass block</span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
