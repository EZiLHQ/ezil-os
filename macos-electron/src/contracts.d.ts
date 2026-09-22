/** Host-only v2 additions. Never add these to the helper's capability API. */
export type WorkspaceKind = 'managed' | 'attached';
export interface ProjectSummary { id: string; name: string; createdAt: string; kind: WorkspaceKind; available: boolean }
export interface DesktopPreferences {
  wallpaper?: 'charcoal' | 'teal-dusk' | 'deep-slate' | 'aurora';
  accent?: 'teal' | 'violet' | 'amber' | 'rose';
  previewPort?: number;
  browser?: { tabs: string[]; activeIndex: number };
  layout?: Array<{ app: 'browser' | 'code' | 'preview' | 'settings'; x: number; y: number; width: number; height: number; minimized: boolean }>;
}
export type ProjectOperation =
  | { op: 'workspace.attach' }
  | { op: 'workspace.relink' | 'workspace.reveal' | 'workspace.openVSCode' | 'workspace.openXcode' | 'toolchain.status' | 'desktop.read'; workspaceId: string }
  | { op: 'desktop.write'; workspaceId: string; preferences: DesktopPreferences };
export interface BrowserStateNotification {
  workspaceId: string; surfaceId: string; generation: number; revision: number;
  url: string; title: string; loading: boolean; error: 'navigation_failed' | null;
  canGoBack: boolean; canGoForward: boolean; zoomFactor: number;
}
export interface BrowserNewTabNotification {
  workspaceId: string; surfaceId: string; generation: number;
  url: string; background: boolean;
}
export interface BrowserZoomOperation {
  op: 'browser.zoom-in' | 'browser.zoom-out' | 'browser.zoom-reset';
  workspaceId: string; surfaceId: string; generation: number; sequence: number;
}
export type BrowserShortcutAction = 'address' | 'reload' | 'back' | 'forward' | 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'zoom-in' | 'zoom-out' | 'zoom-reset';
export type SecureBrowserReason = 'missing' | 'outdated' | 'untrusted' | 'unavailable' | 'profile_busy';
export type SecureBrowserOperation =
  | { op: 'secureBrowser.status'; workspaceId: string }
  | { op: 'secureBrowser.open'; workspaceId: string; destination?: string };
export interface SecureBrowserStatus { available: boolean; version?: string; reason?: SecureBrowserReason }
export interface SecureBrowserOpened { opened: boolean; reason?: SecureBrowserReason }
/** Capability/configuration only, not proof that a site or credential works. */
export interface PasskeyStatus {
  embeddedTouchID: boolean;
  syncedPasskeys: false;
  existingPasskeys: 'secure-browser';
  reason?: 'signing_required' | 'runtime_unsupported' | 'platform_unavailable' | 'setup_failed';
}
export interface PasskeyOperation { op: 'passkeys.status'; workspaceId: string }
export type EditorFailure = 'editor_start_failed' | 'editor_connection_lost' | 'editor_cleanup_unverified';
