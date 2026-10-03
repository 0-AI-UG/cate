export {
  defineSettings,
  setting,
  composeSettings,
  oneOf,
  numberIn,
  everyItem,
  everyValue,
  type SettingsScope,
  type SettingDef,
  type SettingDefs,
  type SettingsSlice,
  type SliceValues,
  type ComposedSettings,
  type SettingsTable,
} from './contract/define'
export {
  SETTINGS_SLICES,
  clientSettingsTable,
  workspaceSettingsTable,
  type ClientSettings,
  type WorkspaceSettings,
  type ClientSettingKey,
  type WorkspaceSettingKey,
} from './contract/composed'
export { settingsCapability, type SetSettingParams } from './contract/capability'
