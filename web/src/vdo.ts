const VDO_BASE = 'https://vdo.ninja/';

// Host deliberately uses screenshare2 (rather than silent/autostart capture).
// Browsers require the user to click the embedded VDO.Ninja button and
// explicitly choose a display, window, or tab in the native capture picker.
export function hostVdoUrl(streamId: string): string {
  const url = new URL(VDO_BASE);
  url.searchParams.set('push', streamId);
  url.searchParams.set('screenshare2', '');
  url.searchParams.set('quality', '0');
  return url.toString();
}

export function viewerVdoUrl(streamId: string): string {
  const url = new URL(VDO_BASE);
  url.searchParams.set('view', streamId);
  url.searchParams.set('cleanoutput', '');
  url.searchParams.set('autostart', '');
  url.searchParams.set('videobitrate', '6000');
  url.searchParams.set('scale', '100');
  return url.toString();
}
