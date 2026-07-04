declare const __APP_VERSION__: string;

declare module '*.css';
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}

// Electron extends the File interface with a `path` property
interface File {
  readonly path?: string;
}
