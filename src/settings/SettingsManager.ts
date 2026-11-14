export type StoneMotionStyle = 'realistic' | 'classic_bowl' | 'instant';
export type PlacementInputMode = 'auto' | 'instant' | 'confirm' | 'double_tap';
export type EffectiveInputMode = 'instant' | 'confirm' | 'double_tap';
export type PhysicsIntensity = 'realistic' | 'subtle' | 'minimal';
export type LightingTheme = 'hanok_warm' | 'studio_bright' | 'night_lantern';
export type VisualQuality = 'ultra' | 'high' | 'standard';

export interface UserSettings {
  stoneMotionStyle: StoneMotionStyle;
  trueVerticalView: boolean;
  autoMobileVerticalView: boolean;
  lockVerticalRotation: boolean;
  inputMode: PlacementInputMode;
  touchLoupeEnabled: boolean;
  physicsIntensity: PhysicsIntensity;
  lightingTheme: LightingTheme;
  visualQuality: VisualQuality;
  bloomEnabled: boolean;
  ornateFinishEnabled: boolean;
  showCoordinates: boolean;
  showMoveNumbers: boolean;
  showForbiddenPoints: boolean;
  soundVolume: number;
  soundMuted: boolean;
}

export function getDefaultVisualQuality(): VisualQuality {
  return isMobileOrTouchViewport() ? 'high' : 'ultra';
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  stoneMotionStyle: 'realistic',
  trueVerticalView: false,
  autoMobileVerticalView: true,
  lockVerticalRotation: true,
  inputMode: 'auto',
  touchLoupeEnabled: true,
  physicsIntensity: 'realistic',
  lightingTheme: 'hanok_warm',
  visualQuality: 'ultra',
  bloomEnabled: true,
  ornateFinishEnabled: true,
  showCoordinates: true,
  showMoveNumbers: false,
  showForbiddenPoints: true,
  soundVolume: 0.78,
  soundMuted: false,
};

const STORAGE_KEY = 'sudam_user_settings_v1';

const VALID_MOTIONS = new Set<StoneMotionStyle>(['realistic', 'classic_bowl', 'instant']);
const VALID_INPUTS = new Set<PlacementInputMode>(['auto', 'instant', 'confirm', 'double_tap']);
const VALID_PHYSICS = new Set<PhysicsIntensity>(['realistic', 'subtle', 'minimal']);
const VALID_THEMES = new Set<LightingTheme>(['hanok_warm', 'studio_bright', 'night_lantern']);
const VALID_QUALITIES = new Set<VisualQuality>(['ultra', 'high', 'standard']);

export function isMobileOrTouchViewport(): boolean {
  if (typeof window === 'undefined') return false;
  const smallViewport = window.innerWidth <= 820;
  const coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const touchCapable =
    typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && window.innerWidth <= 1024;
  return smallViewport || coarsePointer || touchCapable;
}

export function resolveEffectiveInputMode(mode: PlacementInputMode): EffectiveInputMode {
  if (mode === 'auto') {
    return isMobileOrTouchViewport() ? 'confirm' : 'instant';
  }
  return mode;
}

function createPlatformDefaults(): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    visualQuality: getDefaultVisualQuality(),
  };
}

function sanitizeSettings(raw: Partial<UserSettings> | null | undefined): UserSettings {
  const base: UserSettings = createPlatformDefaults();
  if (!raw || typeof raw !== 'object') return base;

  if (raw.stoneMotionStyle && VALID_MOTIONS.has(raw.stoneMotionStyle)) {
    base.stoneMotionStyle = raw.stoneMotionStyle;
  }
  if (typeof raw.trueVerticalView === 'boolean') base.trueVerticalView = raw.trueVerticalView;
  if (typeof raw.autoMobileVerticalView === 'boolean') {
    base.autoMobileVerticalView = raw.autoMobileVerticalView;
  }
  if (typeof raw.lockVerticalRotation === 'boolean') {
    base.lockVerticalRotation = raw.lockVerticalRotation;
  }
  if (raw.inputMode && VALID_INPUTS.has(raw.inputMode)) {
    base.inputMode = raw.inputMode;
  }
  if (typeof raw.touchLoupeEnabled === 'boolean') base.touchLoupeEnabled = raw.touchLoupeEnabled;
  if (raw.physicsIntensity && VALID_PHYSICS.has(raw.physicsIntensity)) {
    base.physicsIntensity = raw.physicsIntensity;
  }
  if (raw.lightingTheme && VALID_THEMES.has(raw.lightingTheme)) {
    base.lightingTheme = raw.lightingTheme;
  }
  if (raw.visualQuality && VALID_QUALITIES.has(raw.visualQuality)) {
    base.visualQuality = raw.visualQuality;
  }
  if (typeof raw.bloomEnabled === 'boolean') base.bloomEnabled = raw.bloomEnabled;
  if (typeof raw.ornateFinishEnabled === 'boolean') base.ornateFinishEnabled = raw.ornateFinishEnabled;
  if (typeof raw.showCoordinates === 'boolean') base.showCoordinates = raw.showCoordinates;
  if (typeof raw.showMoveNumbers === 'boolean') base.showMoveNumbers = raw.showMoveNumbers;
  if (typeof raw.showForbiddenPoints === 'boolean') {
    base.showForbiddenPoints = raw.showForbiddenPoints;
  }
  if (typeof raw.soundVolume === 'number' && Number.isFinite(raw.soundVolume)) {
    base.soundVolume = Math.max(0, Math.min(1, raw.soundVolume));
  }
  if (typeof raw.soundMuted === 'boolean') base.soundMuted = raw.soundMuted;

  return base;
}

export class SettingsManager {
  private settings: UserSettings;
  private listeners = new Set<(settings: UserSettings) => void>();

  constructor() {
    this.settings = this.loadFromStorage();
  }

  private loadFromStorage(): UserSettings {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return createPlatformDefaults();
      }
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return createPlatformDefaults();
      const parsed = JSON.parse(raw) as Partial<UserSettings>;
      return sanitizeSettings(parsed);
    } catch {
      return createPlatformDefaults();
    }
  }

  private saveToStorage(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Ignore storage quota or private browsing errors
    }
  }

  public get(): Readonly<UserSettings> {
    return this.settings;
  }

  public update(patch: Partial<UserSettings>): UserSettings {
    const next = sanitizeSettings({ ...this.settings, ...patch });
    this.settings = next;
    this.saveToStorage();
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  public resetDefaults(): UserSettings {
    return this.update(createPlatformDefaults());
  }

  public subscribe(listener: (settings: UserSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
