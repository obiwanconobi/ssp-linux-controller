import { MAX_PRESET_NAME_BYTES, presetNameBytes } from './presetNames';
import type {
  Block,
  BlockPreset,
  BlockPresetValue,
  Control,
  ControlGroup,
} from '../types';

export interface BlockPresetChange {
  path: string;
  before: BlockPresetValue;
  after: BlockPresetValue;
}

export interface PreparedBlockPreset {
  values: Record<string, BlockPresetValue>;
  warnings: string[];
}

/** Stable, human-readable folder name for a block type. */
export const blockPresetKey = (block: Block): string => {
  const lastSegment = block.id.split(/[\\/]/).filter(Boolean).pop() ?? block.id;
  const key = lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key.slice(0, 64) || 'block';
};

export const blockPresetNameError = (name: string): string | null => {
  if (!name) return 'Preset name cannot be empty';
  if (/[\u0000-\u001f]/.test(name)) {
    return 'Preset name cannot contain control characters';
  }
  if (presetNameBytes(name) > MAX_PRESET_NAME_BYTES) {
    return `Preset name must be at most ${MAX_PRESET_NAME_BYTES} bytes`;
  }
  return null;
};

const allPresetControls = (block: Block): Control[] => {
  const controls = [...block.controls];
  const walk = (groups: ControlGroup[]) => {
    for (const group of groups) {
      controls.push(...group.controls);
      if (group.groups) walk(group.groups);
    }
  };
  walk(block.groups);
  if (block.secondLane) controls.push(...block.secondLane.controls);
  return controls;
};

const findPresetControl = (block: Block, id: string): Control | undefined =>
  allPresetControls(block).find((control) => control.id === id);

/**
 * Flatten everything that belongs to the block's sound. Bypass state, chain
 * position, and link mode are deliberately excluded.
 */
export const collectBlockValues = (block: Block): Record<string, BlockPresetValue> => {
  const values: Record<string, BlockPresetValue> = {};
  const add = (id: string | undefined, value: BlockPresetValue | undefined) => {
    if (id && value !== undefined) values[id] = value;
  };

  for (const control of block.controls) add(control.id, control.value);
  for (const group of block.groups) {
    const walk = (item: ControlGroup) => {
      for (const control of item.controls) add(control.id, control.value);
      if (item.onOffId && item.enabled !== undefined) {
        add(item.onOffId, item.enabled ? 'ON' : 'OFF');
      }
      if (item.modePath && item.modeValue !== undefined) {
        add(item.modePath, item.modeValue);
      }
      for (const nested of item.groups ?? []) walk(nested);
    };
    walk(group);
  }
  if (block.secondLane) {
    for (const control of block.secondLane.controls) add(control.id, control.value);
    if (block.secondLane.onOffId && block.secondLane.enabled !== undefined) {
      add(block.secondLane.onOffId, block.secondLane.enabled ? 'ON' : 'OFF');
    }
  }

  // Model controls are often filtered out of the visible control list, so the
  // block-level cache is the reliable source for the selected model name.
  add(block.modelControlId, block.model);
  if (block.secondLane) {
    add(block.secondLane.modelControlId, block.secondLane.model);
  }

  return values;
};

export const captureBlockPreset = (block: Block, name: string): BlockPreset => ({
  version: 1,
  name: name.trim(),
  blockKey: blockPresetKey(block),
  blockPath: block.id,
  blockLabel: block.label,
  family: block.family,
  savedAt: new Date().toISOString(),
  values: collectBlockValues(block),
});

/**
 * If a block exposes a model selector, make sure the preset's model exists.
 * Missing or stale model names fall back to the first available option and are
 * reported to the caller so the UI can flag the substitution.
 */
export const prepareBlockPresetValues = (
  block: Block,
  preset: BlockPreset,
): PreparedBlockPreset => {
  const values = { ...preset.values };
  const warnings: string[] = [];

  const resolveModel = (
    controlId: string | undefined,
    options: string[] | undefined,
    label: string,
  ) => {
    if (!controlId) return;
    const available = (options ?? []).filter((option) => option.trim().length > 0);
    if (available.length === 0) return;

    const requested = values[controlId];
    if (requested === undefined) {
      const fallback = available[0];
      values[controlId] = fallback;
      warnings.push(`Preset has no model for ${label}; using “${fallback}”.`);
      return;
    }
    const matched = available.find(
      (option) => option.toLowerCase() === String(requested).toLowerCase(),
    );
    if (!matched) {
      const fallback = available[0];
      values[controlId] = fallback;
      warnings.push(
        `Model “${String(requested)}” is not available for ${label}; using “${fallback}”.`,
      );
    } else {
      values[controlId] = matched;
    }
  };

  const modelControl = block.modelControlId
    ? findPresetControl(block, block.modelControlId)
    : undefined;
  resolveModel(
    block.modelControlId,
    modelControl?.options ?? block.modelOptions,
    modelControl?.label ?? block.label,
  );

  const lane = block.secondLane;
  if (lane?.modelControlId) {
    const laneControl = findPresetControl(block, lane.modelControlId);
    resolveModel(
      lane.modelControlId,
      laneControl?.options ?? lane.modelOptions,
      lane.label,
    );
  }

  return { values, warnings };
};

const sameValue = (left: BlockPresetValue, right: BlockPresetValue): boolean =>
  typeof left === 'number' && typeof right === 'number'
    ? Math.abs(left - right) < 1e-9
    : left === right;

/** Values in the preset that differ from the block's current state. */
export const blockPresetChanges = (
  block: Block,
  values: Record<string, BlockPresetValue>,
): BlockPresetChange[] => {
  const current = collectBlockValues(block);
  const changes: BlockPresetChange[] = [];
  for (const [path, after] of Object.entries(values)) {
    const before = current[path];
    if (before === undefined || sameValue(before, after)) continue;
    changes.push({ path, before, after });
  }
  return changes;
};

/**
 * Type changes must land first because they can replace the editor's control
 * set. Model selectors follow, then ordinary parameters.
 */
export const sortBlockPresetChanges = (
  block: Block,
  changes: BlockPresetChange[],
): BlockPresetChange[] => {
  const typeIds = new Set(
    allPresetControls(block)
      .filter((control) => control.name === 'type')
      .map((control) => control.id),
  );
  const modelIds = new Set(
    [block.modelControlId, block.secondLane?.modelControlId].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const priority = (path: string) =>
    typeIds.has(path) ? 0 : modelIds.has(path) ? 1 : 2;
  return [...changes].sort((left, right) => priority(left.path) - priority(right.path));
};

/** Apply a preset's resolved values to a block without touching bypass state. */
export const applyPresetValuesToBlock = (
  block: Block,
  values: Record<string, BlockPresetValue>,
): Block => {
  const applyControl = (control: Control): Control => {
    const value = values[control.id];
    return value === undefined ? control : { ...control, value };
  };

  const applyGroup = (group: ControlGroup): ControlGroup => {
    const onValue = group.onOffId ? values[group.onOffId] : undefined;
    const modeValue = group.modePath ? values[group.modePath] : undefined;
    return {
      ...group,
      enabled:
        onValue === undefined
          ? group.enabled
          : onValue === 'ON' || onValue === true,
      modeValue:
        modeValue === undefined ? group.modeValue : String(modeValue),
      controls: group.controls.map(applyControl),
      groups: group.groups?.map(applyGroup),
    };
  };

  const mainModel = block.modelControlId
    ? values[block.modelControlId]
    : undefined;
  const nextModel = mainModel === undefined ? block.model : String(mainModel);
  let label = block.label;
  if (
    mainModel !== undefined &&
    block.model &&
    nextModel !== block.model &&
    label.includes(block.model)
  ) {
    label = label.split(block.model).join(nextModel);
  }

  const lane = block.secondLane;
  const laneModel =
    lane?.modelControlId === undefined ? undefined : values[lane.modelControlId];
  const laneOnValue = lane?.onOffId ? values[lane.onOffId] : undefined;

  return {
    ...block,
    label,
    model: nextModel,
    controls: block.controls.map(applyControl),
    groups: block.groups.map(applyGroup),
    secondLane: lane
      ? {
          ...lane,
          model: laneModel === undefined ? lane.model : String(laneModel),
          enabled:
            laneOnValue === undefined
              ? lane.enabled
              : laneOnValue === 'ON' || laneOnValue === true,
          controls: lane.controls.map(applyControl),
        }
      : undefined,
  };
};
