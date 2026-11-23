import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** Токены — в защищённом хранилище телефона (Keychain/Keystore); в браузерном просмотре — localStorage. */
export const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string | null): Promise<void> {
    if (Platform.OS === 'web') {
      try { value === null ? globalThis.localStorage?.removeItem(key) : globalThis.localStorage?.setItem(key, value); } catch { /* приватный режим */ }
      return;
    }
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  },
};
