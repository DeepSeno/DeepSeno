import type { AppLogLevel, RendererLogInput } from '../hooks/useApi';

let installed = false;

function isLogsRoute(): boolean {
  return window.location.hash.startsWith('#/logs');
}

function send(entry: RendererLogInput): void {
  if (!window.api?.appendRendererLog) return;
  window.api.appendRendererLog(entry).catch(() => {});
}

function textOf(el: Element): string {
  const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
  const text = (aria || el.textContent || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 120);
}

function selectorOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string'
    ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).map((item) => `.${item}`).join('')
    : '';
  return `${tag}${id}${cls}`;
}

function closestInteractive(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('button,a,input,select,textarea,[role="button"],[data-log-name]');
}

function describeInteractive(el: Element): Record<string, unknown> {
  const input = el instanceof HTMLInputElement ? el : null;
  return {
    route: window.location.hash || '#/',
    selector: selectorOf(el),
    label: el.getAttribute('data-log-name') || textOf(el),
    role: el.getAttribute('role') || undefined,
    type: input?.type,
    disabled: el instanceof HTMLButtonElement || el instanceof HTMLInputElement
      ? el.disabled
      : undefined,
  };
}

function logUi(level: AppLogLevel, message: string, details?: unknown): void {
  send({
    level,
    scope: 'ui',
    message,
    details,
  });
}

export function installRendererDiagnostics(): void {
  if (installed || isLogsRoute()) return;
  installed = true;

  logUi('info', 'Renderer diagnostics installed', {
    route: window.location.hash || '#/',
    userAgent: navigator.userAgent,
  });

  window.addEventListener('hashchange', () => {
    logUi('info', 'Route changed', {
      route: window.location.hash || '#/',
    });
  });

  window.addEventListener('error', (event) => {
    logUi('error', 'Unhandled renderer error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logUi('error', 'Unhandled renderer promise rejection', {
      reason: reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : String(reason),
    });
  });

  document.addEventListener('click', (event) => {
    const el = closestInteractive(event.target);
    if (!el) return;
    logUi('info', 'User clicked UI control', describeInteractive(el));
  }, true);

  document.addEventListener('change', (event) => {
    const el = closestInteractive(event.target);
    if (!el) return;
    logUi('info', 'User changed UI control', describeInteractive(el));
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    logUi('info', 'User submitted form', {
      route: window.location.hash || '#/',
      selector: form ? selectorOf(form) : undefined,
    });
  }, true);
}
