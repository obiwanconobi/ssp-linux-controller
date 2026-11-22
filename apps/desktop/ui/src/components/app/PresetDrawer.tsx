import * as Dialog from '@radix-ui/react-dialog';
import { PresetRail } from '../kit/PresetRail';
import { useAppStore } from '../../stores/useAppStore';

export const PresetDrawer = () => {
  const open = useAppStore((state) => state.presetDrawerOpen);
  const setOpen = useAppStore((state) => state.setPresetDrawerOpen);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content preset-drawer"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document
              .querySelector<HTMLButtonElement>('[aria-label="Open patches drawer"]')
              ?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Patches</Dialog.Title>
          <PresetRail onClose={() => setOpen(false)} onSelect={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
