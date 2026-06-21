declare const __APP_VERSION__: string;

// Electron extends the File interface with a `path` property
interface File {
  readonly path?: string;
}
