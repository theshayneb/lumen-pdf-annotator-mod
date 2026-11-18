// The few parts of Obsidian's API the storage code touches, for tests run in Node.
export const normalizePath = path => path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Vault {}
export class App {}
export class Modal { constructor(app) { this.app = app; } }
export class Setting {}
export class Notice {}
export const Platform = { isDesktopApp: true, isMobile: false };
export const setIcon = () => {};
