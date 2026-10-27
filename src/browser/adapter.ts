export type PageId = string;
export type MouseButton = "left" | "right" | "middle";

export interface LaunchOptions {
  extensionPaths?: string[];
}

export interface BrowserAdapter {
  readonly name: string;
  launch(options?: LaunchOptions): Promise<void>;
  openPage(): Promise<PageId>;
  closePage(page: PageId): Promise<void>;
  goto(page: PageId, url: string): Promise<void>;
  setViewport(page: PageId, width: number, height: number, scale?: number): Promise<void>;
  screenshot(page: PageId): Promise<Uint8Array>;
  mouseMove(page: PageId, x: number, y: number): Promise<void>;
  mouseDown(page: PageId, button?: MouseButton): Promise<void>;
  mouseUp(page: PageId, button?: MouseButton): Promise<void>;
  mouseClick(page: PageId, x: number, y: number, clickCount?: number): Promise<void>;
  keyboardType(page: PageId, text: string): Promise<void>;
  keyboardPress(page: PageId, key: string): Promise<void>;
  findExtensionId(name: string): Promise<string | null>;
  openExtensionPage(extensionId: string, path: string, pinTo: PageId | null): Promise<PageId>;
  tabIdOf(extensionId: string, path: string, page: PageId): Promise<number>;
  evaluate<T = unknown>(page: PageId, expression: string): Promise<T>;
  close(): Promise<void>;
}

export type AdapterFactory = () => BrowserAdapter;
