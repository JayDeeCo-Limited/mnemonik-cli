export const debug = (_msg, _ctx) => { };
export const info = (msg, ctx) => {
    console.log(`[info] ${msg}`, ctx ? JSON.stringify(ctx) : '');
};
export const warn = (msg, ctx) => {
    console.warn(`[warn] ${msg}`, ctx ? JSON.stringify(ctx) : '');
};
//# sourceMappingURL=logger.js.map