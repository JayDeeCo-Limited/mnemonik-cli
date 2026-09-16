export const actionRequired = (state) => ({
    status: 'ACTION_REQUIRED',
    state,
    allowedActions: ['retry', 'cancel'],
});
//# sourceMappingURL=contracts.js.map