// Still-photo camera access. The camera starts only when the user presses a
// button, prefers the rear camera, and is released when the user captures,
// closes it, leaves the screen, or hides the page. There is no recording and
// no background capture. Media access is injected, so it can be tested.

export interface TrackLike {
  stop(): void;
  getSettings?(): { deviceId?: string; facingMode?: string };
}
export interface StreamLike {
  getTracks(): readonly TrackLike[];
}
export interface MediaDevicesLike {
  getUserMedia(constraints: { video: unknown; audio: false }): Promise<StreamLike>;
  enumerateDevices?(): Promise<readonly { kind: string; deviceId: string; label: string }[]>;
}

export type CameraFailure = 'unsupported' | 'insecure' | 'denied' | 'not-found' | 'busy' | 'error' | 'cancelled';

export type StartResult =
  | { readonly ok: true; readonly stream: StreamLike }
  | { readonly ok: false; readonly reason: CameraFailure; readonly message: string };

export const CAMERA_MESSAGES: Record<Exclude<CameraFailure, 'cancelled'>, string> = {
  unsupported: 'This browser cannot use a camera here. Upload a photo instead.',
  insecure: 'Camera access needs a secure page (HTTPS or localhost). Upload a photo instead.',
  denied: 'Camera permission was denied. Allow the camera for this site in the browser settings, or upload a photo instead.',
  'not-found': 'No camera was found. Upload a photo instead.',
  busy: 'The camera is in use by another app. Close it and try again, or upload a photo.',
  error: 'The camera could not be started. Upload a photo instead.',
};

export class CameraController {
  private current: StreamLike | null = null;
  private generation = 0;
  private devices: { deviceId: string; label: string }[] = [];
  private deviceIndex = -1;

  constructor(private readonly media: MediaDevicesLike | undefined, private readonly secure: boolean) {}

  /** Whether the browser offers camera access on this page at all. */
  get available(): boolean {
    return !!this.media?.getUserMedia && this.secure;
  }

  get stream(): StreamLike | null {
    return this.current;
  }

  get live(): boolean {
    return this.current !== null;
  }

  /** Start the camera after an explicit user action. Prefers the rear camera unless a device is given. */
  async start(deviceId?: string): Promise<StartResult> {
    if (!this.media?.getUserMedia) return { ok: false, reason: 'unsupported', message: CAMERA_MESSAGES.unsupported };
    if (!this.secure) return { ok: false, reason: 'insecure', message: CAMERA_MESSAGES.insecure };
    this.stop();
    const generation = ++this.generation;
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } };
    let stream: StreamLike;
    try {
      stream = await this.media.getUserMedia({ video, audio: false });
    } catch (error) {
      if (generation !== this.generation) return { ok: false, reason: 'cancelled', message: '' };
      const name = (error as { name?: string })?.name;
      const reason: CameraFailure = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'not-found'
          : name === 'NotReadableError' || name === 'AbortError' ? 'busy' : 'error';
      return { ok: false, reason, message: CAMERA_MESSAGES[reason] };
    }
    // Closed or restarted while waiting for permission: release this stream at once.
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return { ok: false, reason: 'cancelled', message: '' };
    }
    this.current = stream;
    await this.refreshDevices(stream);
    return { ok: true, stream };
  }

  private async refreshDevices(stream: StreamLike) {
    try {
      const all = (await this.media?.enumerateDevices?.()) ?? [];
      this.devices = all.filter(d => d.kind === 'videoinput').map(d => ({ deviceId: d.deviceId, label: d.label }));
    } catch {
      this.devices = [];
    }
    const active = stream.getTracks()[0]?.getSettings?.().deviceId;
    this.deviceIndex = Math.max(0, this.devices.findIndex(d => d.deviceId === active));
  }

  /** True when more than one camera is available to switch between. */
  get canSwitch(): boolean {
    return this.devices.length > 1;
  }

  /** Switch to the next camera, if there is one. */
  async switchCamera(): Promise<StartResult | null> {
    if (!this.canSwitch) return null;
    const next = this.devices[(this.deviceIndex + 1) % this.devices.length];
    return this.start(next.deviceId);
  }

  /** Release the camera. Safe to call any time, including while a start is pending. */
  stop(): void {
    this.generation++;
    if (this.current) for (const track of this.current.getTracks()) track.stop();
    this.current = null;
  }
}
