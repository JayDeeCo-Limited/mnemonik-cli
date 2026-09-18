import { access, stat } from 'node:fs/promises';
export const hostDiscovery = {
    pathExists: (path) => access(path).then(() => true, () => false),
    binaryExists: async (file) => (await stat(file).catch(() => undefined))?.isFile() === true,
};
//# sourceMappingURL=hostDiscovery.js.map