import { Button, Notice, uploadFile } from '@kovsh/mobile';
import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { View } from 'react-native';

/** Выбрать файл (фото или PDF), загрузить на сервер и передать id дальше. */
export function FileButton({ title, onUploaded, images, small = true }: { title: string; onUploaded: (fileId: string) => Promise<unknown>; images?: boolean; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick() {
    setError(null);
    const r = await DocumentPicker.getDocumentAsync({ type: images ? ['image/*'] : ['image/*', 'application/pdf'], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    setBusy(true);
    try {
      const f = await uploadFile({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? 'application/octet-stream', webFile: a.file });
      await onUploaded(f.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить файл');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 6 }}>
      <Button kind="secondary" small={small} title={title} loading={busy} onPress={pick} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </View>
  );
}
