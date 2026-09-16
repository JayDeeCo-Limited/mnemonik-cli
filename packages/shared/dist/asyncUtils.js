export function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(timeoutMessage ?? `Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
    });
}
//# sourceMappingURL=asyncUtils.js.map