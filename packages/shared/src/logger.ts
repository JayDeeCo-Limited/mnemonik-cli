export const debug = (_msg: string, _ctx?: Record<string, unknown>): void => {};
export const info = (msg: string, ctx?: Record<string, unknown>): void => {
  console.log(`[info] ${msg}`, ctx ? JSON.stringify(ctx) : '');
};
export const warn = (msg: string, ctx?: Record<string, unknown>): void => {
  console.warn(`[warn] ${msg}`, ctx ? JSON.stringify(ctx) : '');
};
