import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Boxes, MoreHorizontal, Trash2, Unlock, ArrowLeftRight, Replace } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import type { Block, Control, ControlGroup } from '../../types';
import { Knob } from './Knob';

const familyLabel: Record<Block['family'], string> = {
  gate: 'Gate',
  pitch: 'Pitch',
  comp: 'Comp',
  drive: 'Drive',
  amp: 'Amp',
  cab: 'Cab',
  mod: 'Mod',
  delay: 'Delay',
  reverb: 'Verb',
  utility: 'Utility',
};

const Continuous = ({
  control,
  pending,
  onChange,
  size = 'lg',
}: {
  control: Control;
  pending: boolean;
  onChange: (value: number) => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) => (
  <div className="control-field">
    <Knob
      control={control}
      size={size}
      pending={pending}
      onChange={onChange}
      label={control.label}
    />
  </div>
);

const Segmented = ({
  label,
  value,
  options,
  pending,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  pending: boolean;
  onChange: (value: string) => void;
}) => (
  <div className="inspector__type">
    <span className="field-label">{label}</span>
    <div className="segmented segmented--fill" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          disabled={pending}
          onClick={() => {
            if (option !== value) onChange(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  </div>
);

const ControlField = ({
  control,
  pending,
  onChange,
}: {
  control: Control;
  pending: boolean;
  onChange: (value: number | string | boolean) => void;
}) => {
  if (control.kind === 'float' || control.kind === 'pfloat' || control.kind === 'number') {
    return (
      <Continuous
        control={control}
        pending={pending}
        onChange={(value) => onChange(value)}
      />
    );
  }
  if (control.kind === 'enum' || control.kind === 'choice') {
    return (
      <label className="control-select">
        <span className="field-label">{control.label}</span>
        <select
          className="select"
          value={String(control.value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(control.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (control.kind === 'bool') {
    return (
      <button
        type="button"
        className="switch control-switch"
        aria-checked={Boolean(control.value)}
        onClick={() => onChange(!control.value)}
      >
        <span className="switch__track">
          <span className="switch__thumb" />
        </span>
        <span>{control.label}</span>
      </button>
    );
  }
  return (
    <label className="control-text">
      <span className="field-label">{control.label}</span>
      <input
        className="input"
        value={String(control.value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
};

const GroupSection = ({
  group,
  pending,
  onChange,
  onToggle,
}: {
  group: ControlGroup;
  pending: Set<string>;
  onChange: (id: string, value: number | string | boolean) => void;
  onToggle: (id: string, value: boolean) => void;
}) => (
  <section className="inspector-group">
    <header className="inspector-group__head">
      <div>
        <span className="section-title">{group.label}</span>
        <span className="inspector-group__kind mono">
          {group.itemType === 'module' ? 'tempo module' : group.itemType === 'vfolder_tc' ? 'switchable group' : 'group'}
        </span>
      </div>
      {group.onOffId && (
        <button
          type="button"
          className="switch"
          aria-checked={Boolean(group.enabled)}
          onClick={() => onToggle(group.onOffId!, !group.enabled)}
        >
          <span className="switch__track">
            <span className="switch__thumb" />
          </span>
          <span>{group.enabled ? 'On' : 'Off'}</span>
        </button>
      )}
    </header>
    {group.modeOptions && group.modePath && (
      <label className="control-select inspector-group__mode">
        <span className="field-label">Mode</span>
        <select
          className="select"
          value={group.modeValue ?? group.modeOptions[0]?.value}
          onChange={(event) => onChange(group.modePath!, event.target.value)}
        >
          {group.modeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )}
    <div className="control-grid control-grid--group">
      {group.controls.map((control) => (
        <ControlField
          key={control.id}
          control={control}
          pending={pending.has(control.id)}
          onChange={(value) => onChange(control.id, value)}
        />
      ))}
    </div>
    {group.groups?.map((nested) => (
      <GroupSection
        key={nested.id}
        group={nested}
        pending={pending}
        onChange={onChange}
        onToggle={onToggle}
      />
    ))}
  </section>
);

export const Inspector = () => {
  const block = useAppStore((state) => state.blocks.find((item) => item.id === state.selectedBlockId));
  const blocks = useAppStore((state) => state.blocks);
  const pending = new Set(useAppStore((state) => state.pending));
  const setControl = useAppStore((state) => state.setControl);
  const setBlockModel = useAppStore((state) => state.setBlockModel);
  const toggleBlock = useAppStore((state) => state.toggleBlock);
  const setLink = useAppStore((state) => state.setLink);
  const removeBlock = useAppStore((state) => state.removeBlock);
  const replaceBlock = useAppStore((state) => state.replaceBlock);
  const availableBlocks = useAppStore((state) => state.availableBlocks);
  const setView = useAppStore((state) => state.setView);
  const edited = useAppStore((state) => state.save.edited);
  const saving = useAppStore((state) => state.save.saving);

  if (!block) {
    return (
      <section className="inspector panel inspector--empty">
        <Boxes size={26} aria-hidden="true" />
        <h2>Select a block</h2>
        <p>The inspector follows the chain: choose a pedal to edit its controls here.</p>
      </section>
    );
  }

  const index = blocks.findIndex((item) => item.id === block.id);
  const previous = index > 0 ? blocks[index - 1] : undefined;
  const modelControl = block.modelControlId
    ? block.controls.find((control) => control.id === block.modelControlId)
    : undefined;
  const typeControl = block.controls.find(
    (control) => control.name === 'type' && control.visible !== false,
  );
  const typeOptions = typeControl?.options ?? [];
  const showType = Boolean(typeControl && typeOptions.length > 1);
  const replacementOptions = availableBlocks.filter(
    (item) =>
      item.id !== block.id &&
      !blocks.some((existing) => existing.id === item.id || existing.label === item.label),
  );

  const toggleGroup = (id: string, value: boolean) => {
    if (id.endsWith('on_off')) {
      setControl(id, value ? 'ON' : 'OFF');
      return;
    }
    setControl(id, value);
  };

  return (
    <section className="inspector panel" aria-label={`${block.label} inspector`}>
      <header className="inspector__head">
        <div className="inspector__identity">
          <span className={`inspector__badge inspector__badge--${block.family}`}>
            {familyLabel[block.family]}
          </span>
          <div>
            <h2 className="inspector__title">{block.label}</h2>
            <p className="inspector__sub">
              {block.model ?? 'No model'} · {block.controls.length + block.groups.length} controls
              {block.fixed && ' · fixed slot'}
            </p>
          </div>
        </div>
        <div className="inspector__head-actions">
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={block.on}
            onClick={() => toggleBlock(block.id)}
          >
            <span className={`led ${block.on ? 'led--on' : 'led--off'}`} aria-hidden="true" />
            {block.on ? 'On' : 'Off'}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="icon-btn" aria-label="Block actions">
                <MoreHorizontal size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" sideOffset={6} align="end">
                <DropdownMenu.Item
                  className="menu__item"
                  onSelect={() => {
                    if (block.fixed) return;
                    removeBlock(block.id);
                  }}
                  disabled={block.fixed}
                >
                  <span>
                    <strong>Remove from chain</strong>
                    <small>{block.fixed ? 'Fixed slots cannot be removed' : 'Undo is available'}</small>
                  </span>
                  <Trash2 size={12} />
                </DropdownMenu.Item>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger
                    className="menu__item"
                    disabled={block.fixed || replacementOptions.length === 0}
                  >
                    <span>
                      <strong>Replace with</strong>
                      <small>
                        {block.fixed
                          ? 'Fixed slots cannot be replaced'
                          : replacementOptions.length === 0
                            ? 'No other blocks available'
                            : 'Swap this block in one action'}
                      </small>
                    </span>
                    <Replace size={12} />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      className="menu menu--sub"
                      sideOffset={6}
                      alignOffset={-4}
                    >
                      {replacementOptions.map((item) => (
                        <DropdownMenu.Item
                          key={item.id}
                          className="menu__item"
                          onSelect={() => replaceBlock(block.id, item.id)}
                        >
                          <span>
                            <strong>{item.label}</strong>
                            <small>{item.desc || 'Available block'}</small>
                          </span>
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
                <DropdownMenu.Item
                  className="menu__item"
                  onSelect={() => setLink(block.id, block.link !== 'parallel')}
                >
                  <span>
                    <strong>Link {block.link === 'parallel' ? 'series' : 'parallel'}</strong>
                    <small>Current: {block.link}</small>
                  </span>
                  <ArrowLeftRight size={12} />
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {showType && typeControl && (
        <Segmented
          label={typeControl.label}
          value={String(typeControl.value)}
          options={typeOptions}
          pending={pending.has(typeControl.id)}
          onChange={(value) => setControl(typeControl.id, value)}
        />
      )}

      {block.modelOptions && (
        <div className="inspector__model">
          <label className="field-label" htmlFor={`model-${block.id}`}>
            Model
            <span className="mono">{block.modelOptions.length} loaded</span>
          </label>
          <select
            id={`model-${block.id}`}
            className="select inspector__model-select"
            value={block.model}
            onChange={(event) => setBlockModel(block.id, event.target.value)}
          >
            {block.modelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )}

      {block.family === 'amp' && (
        <button type="button" className="inspector__focus" onClick={() => setView('amp')}>
          <Boxes size={13} />
          Open amp room
          <span className="kbd">Enter</span>
        </button>
      )}

      <div className="control-grid">
        {block.controls
          .filter(
            (control) =>
              control.id !== block.modelControlId &&
              control.id !== typeControl?.id &&
              control.visible !== false,
          )
          .map((control) => (
            <ControlField
              key={control.id}
              control={control}
              pending={pending.has(control.id)}
              onChange={(value) => setControl(control.id, value)}
            />
          ))}
        {modelControl && (
          <ControlField
            key={modelControl.id}
            control={modelControl}
            pending={pending.has(modelControl.id)}
            onChange={(value) => setControl(modelControl.id, value)}
          />
        )}
      </div>

      {block.groups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          pending={pending}
          onChange={(id, value) => setControl(id, value)}
          onToggle={toggleGroup}
        />
      ))}

      <footer className="inspector__foot">
        <div className="inspector__routing">
          <span className="field-label">Routing</span>
          <div className="segmented" role="group" aria-label="Chain link">
            <button
              type="button"
              aria-pressed={block.link === 'series'}
              onClick={() => setLink(block.id, false)}
            >
              Series
            </button>
            <button
              type="button"
              aria-pressed={block.link === 'parallel'}
              onClick={() => setLink(block.id, true)}
            >
              Parallel
            </button>
          </div>
          <span className="hint">
            {previous ? `after ${previous.shortName}` : 'first in chain'}
          </span>
        </div>
        <div className="inspector__state">
          {edited ? (
            <span className="inspector__edited">
              <Unlock size={11} />
              {saving ? 'Saving…' : 'Edited · Ctrl+S to save'}
            </span>
          ) : (
            <span className="chip chip--good">Saved</span>
          )}
        </div>
      </footer>
    </section>
  );
};
