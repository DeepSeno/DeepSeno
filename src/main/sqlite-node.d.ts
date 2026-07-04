declare module 'node:sqlite' {
  interface StatementSync {
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  interface DatabaseSync {
    pragma(sql: string): any;
  }
}
