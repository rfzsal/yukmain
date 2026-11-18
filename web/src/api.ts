export type RoomStatus = 'preparing' | 'live';

export interface RoomData {
  code: string;
  streamId: string;
  status: RoomStatus;
  expiresAt: string;
}

export interface HostRoom extends RoomData {
  hostToken: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  try {
    response = await fetch(path, {
      cache: 'no-store',
      ...options,
      headers,
    });
  } catch {
    throw new Error('Server tidak dapat dihubungi. Pastikan YukMain berjalan.');
  }

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Terjadi kesalahan (${response.status}).`);
  }
  return payload;
}

function hostHeaders(room: HostRoom): HeadersInit {
  return { Authorization: `Bearer ${room.hostToken}` };
}

export const api = {
  createRoom: () => request<HostRoom>('/api/rooms', { method: 'POST' }),
  getRoom: (code: string) => request<RoomData>(`/api/rooms/${encodeURIComponent(code)}`),
  setLive: (room: HostRoom, live: boolean) => request<{ status: RoomStatus }>(
    `/api/rooms/${room.code}`,
    { method: 'PATCH', headers: hostHeaders(room), body: JSON.stringify({ live }) },
  ),
  heartbeat: (room: HostRoom) => request<{ status: RoomStatus }>(
    `/api/rooms/${room.code}/heartbeat`,
    { method: 'POST', headers: hostHeaders(room) },
  ),
  closeRoom: (room: HostRoom) => request<void>(
    `/api/rooms/${room.code}`,
    { method: 'DELETE', headers: hostHeaders(room) },
  ),
};
