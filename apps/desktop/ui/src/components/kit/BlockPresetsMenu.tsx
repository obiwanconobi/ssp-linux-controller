import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Bookmark,
  FolderOpen,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  ipcErrorMessage,
  isMobileRuntime,
  isTauriRuntime,
} from '../../ipc/client';
import {
  blockPresetKey,
  blockPresetNameError,
  captureBlockPreset,
} from '../../lib/blockPresets';
import {
  deleteBlockPreset,
  listBlockPresets,
  openBlockPresetFolder,
  saveBlockPreset,
} from '../../lib/blockPresetStorage';
import { useAppStore } from '../../stores/useAppStore';
import type { Block, BlockPreset } from '../../types';
import { PresetNameDialog } from './PresetNameDialog';

const sortByName = (presets: BlockPreset[]): BlockPreset[] =>
  [...presets].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );

export const BlockPresetsMenu = ({ block }: { block: Block }) => {
  const applyBlockPreset = useAppStore((state) => state.applyBlockPreset);
  const addActivity = useAppStore((state) => state.addActivity);
  const notify = useAppStore((state) => state.notify);
  const key = blockPresetKey(block);
  const [open, setOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [presets, setPresets] = useState<BlockPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const loadRequest = useRef(0);
  const canOpenFolder = isTauriRuntime() && !isMobileRuntime();

  useEffect(() => {
    loadRequest.current += 1;
    setPresets([]);
    setLoadError(null);
    setDeleteTarget(null);
  }, [key]);

  const loadPresets = async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await listBlockPresets(key);
      if (request === loadRequest.current) setPresets(loaded);
    } catch (error) {
      if (request === loadRequest.current) setLoadError(ipcErrorMessage(error));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  };

  const saveCurrent = async (name: string): Promise<boolean> => {
    setSaving(true);
    try {
      const saved = await saveBlockPreset(captureBlockPreset(block, name));
      setPresets((current) => {
        const existing = current.findIndex(
          (preset) => preset.name.toLowerCase() === saved.name.toLowerCase(),
        );
        return sortByName(
          existing >= 0
            ? current.map((preset, index) => (index === existing ? saved : preset))
            : [...current, saved],
        );
      });
      addActivity('Block preset saved', `${block.label} · ${saved.name}`, 'good');
      notify(`“${saved.name}” saved`, 'good');
      return true;
    } catch (error) {
      notify(ipcErrorMessage(error), 'bad');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removePreset = async (name: string) => {
    setDeleting(name);
    try {
      const removed = await deleteBlockPreset(key, name);
      setPresets((current) =>
        current.filter((preset) => preset.name.toLowerCase() !== name.toLowerCase()),
      );
      if (removed) {
        addActivity('Block preset deleted', `${block.label} · ${name}`, 'warn');
        notify(`“${name}” deleted`, 'good');
      } else {
        notify('That preset was already removed', 'warn');
      }
    } catch (error) {
      notify(ipcErrorMessage(error), 'bad');
    } finally {
      setDeleting(null);
      setDeleteTarget(null);
    }
  };

  const openFolder = async () => {
    setOpeningFolder(true);
    try {
      await openBlockPresetFolder(key);
    } catch (error) {
      notify(ipcErrorMessage(error), 'bad');
    } finally {
      setOpeningFolder(false);
    }
  };

  return (
    <>
      <DropdownMenu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) void loadPresets();
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="btn btn--sm block-presets__trigger"
            aria-label={`Block presets for ${block.label}`}
            title="Block presets"
          >
            <Bookmark size={12} aria-hidden="true" />
            <span className="block-presets__label">Presets</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="menu menu--presets"
            sideOffset={6}
            align="end"
            collisionPadding={12}
          >
            <DropdownMenu.Label className="menu__label">Block presets</DropdownMenu.Label>
            <DropdownMenu.Item
              className="menu__item"
              onSelect={() => setSaveOpen(true)}
            >
              <span>
                <strong>Save current preset…</strong>
                <small>Capture every parameter in this block</small>
              </span>
              <Save size={12} aria-hidden="true" />
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu__separator" />

            {loading ? (
              <DropdownMenu.Item className="menu__item" disabled>
                <span>
                  <strong>Loading presets…</strong>
                </span>
              </DropdownMenu.Item>
            ) : loadError ? (
              <DropdownMenu.Item className="menu__item" onSelect={() => void loadPresets()}>
                <span>
                  <strong>Could not load presets</strong>
                  <small>{loadError}</small>
                </span>
                <RefreshCw size={12} aria-hidden="true" />
              </DropdownMenu.Item>
            ) : presets.length === 0 ? (
              <DropdownMenu.Item className="menu__item" disabled>
                <span>
                  <strong>No presets yet</strong>
                  <small>Save the current settings to get started.</small>
                </span>
              </DropdownMenu.Item>
            ) : (
              presets.map((preset) => (
                <DropdownMenu.Item
                  key={preset.name}
                  className="menu__item"
                  onSelect={() => applyBlockPreset(block.id, preset)}
                >
                  <span>
                    <strong>{preset.name}</strong>
                  </span>
                </DropdownMenu.Item>
              ))
            )}

            <DropdownMenu.Separator className="menu__separator" />
            <DropdownMenu.Item
              className="menu__item"
              onSelect={() => setManageOpen(true)}
            >
              <span>
                <strong>Manage presets…</strong>
                <small>Review or delete saved presets</small>
              </span>
              <Settings2 size={12} aria-hidden="true" />
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <PresetNameDialog
        open={saveOpen}
        title="Save block preset"
        description={`Store the current ${block.label} settings as a reusable preset.`}
        initialName={
          block.modelControlId && block.model ? block.model : block.label
        }
        submitLabel="Save preset"
        names={presets.map((preset) => preset.name)}
        allowExisting
        nameLabel="Preset name"
        namePlaceholder="Preset name"
        validate={blockPresetNameError}
        disabled={saving}
        onOpenChange={(next) => {
          if (!next) setSaveOpen(false);
        }}
        onSubmit={saveCurrent}
      />

      <Dialog.Root
        open={manageOpen}
        onOpenChange={(next) => {
          setManageOpen(next);
          if (!next) setDeleteTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <div className="dialog-head">
              <div>
                <Dialog.Title className="dialog-title">Block presets</Dialog.Title>
                <Dialog.Description className="hint">
                  Saved for {block.label}. Presets are stored on this computer.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Close block presets dialog"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="dialog-body">
              {presets.length === 0 ? (
                <p className="hint">No presets are saved for this block yet.</p>
              ) : (
                <div className="block-preset-list">
                  {presets.map((preset) => (
                    <div className="block-preset-row" key={preset.name}>
                      <span className="block-preset-row__name" title={preset.name}>
                        {preset.name}
                      </span>
                      {deleteTarget === preset.name ? (
                        <span className="block-preset-row__confirm">
                          <span className="hint">Delete?</span>
                          <button
                            type="button"
                            className="btn btn--sm btn--danger"
                            aria-label={`Confirm delete ${preset.name}`}
                            disabled={deleting === preset.name}
                            onClick={() => void removePreset(preset.name)}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm"
                            aria-label={`Cancel deleting ${preset.name}`}
                            onClick={() => setDeleteTarget(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Delete ${preset.name}`}
                          title="Delete preset"
                          onClick={() => setDeleteTarget(preset.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="dialog-foot">
              {canOpenFolder && (
                <button
                  type="button"
                  className="btn btn--sm block-presets__open-folder"
                  title="Open this block's preset folder in the file manager"
                  disabled={openingFolder}
                  onClick={() => void openFolder()}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  {openingFolder ? 'Opening…' : 'Open preset folder'}
                </button>
              )}
              <Dialog.Close asChild>
                <button type="button" className="btn">
                  Close
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
};
