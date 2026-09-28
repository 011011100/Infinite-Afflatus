import {
  defaultInteractionSettings,
  type InteractionSettings,
  validateInteractionSettings,
} from '../../shared/interaction/settings';
import type { AppStore } from '../storage/app-store';

/** App-wide preferences stay in userData when the project library moves. */
export class InteractionSettingsStore {
  constructor(private readonly store: AppStore) {}

  get(): InteractionSettings {
    const settings =
      this.store.get<unknown>('interactions') ?? defaultInteractionSettings();
    validateInteractionSettings(settings);
    return settings;
  }

  save(settings: unknown): InteractionSettings {
    validateInteractionSettings(settings);
    this.store.set('interactions', settings);
    return this.get();
  }
}
