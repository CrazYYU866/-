import { useEffect, useState } from 'react';
import { Image, Platform, View, type ImageStyle, type StyleProp } from 'react-native';
import { API_URL, auth } from './api';
import { useTheme } from './theme';

/** Изображение из защищённого хранилища: файл отдаётся только с токеном. */
export function AuthImage({ fileId, style }: { fileId: string; style?: StyleProp<ImageStyle> }) {
  const t = useTheme();
  const url = `${API_URL}/api/v1/files/${fileId}/content`;
  const token = auth.current?.accessToken;
  const [webUrl, setWebUrl] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || !token) return;
    let revoked: string | null = null;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b) { revoked = URL.createObjectURL(b); setWebUrl(revoked); } })
      .catch(() => undefined);
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [url, token]);
  if (Platform.OS === 'web') return webUrl ? <Image source={{ uri: webUrl }} style={style} /> : <View style={[style as object, { backgroundColor: t.surfaceAlt }]} />;
  return <Image source={{ uri: url, headers: token ? { Authorization: `Bearer ${token}` } : undefined }} style={style} />;
}
