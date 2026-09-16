export interface IdentityFixtureAdapter {
  parse(text: string): unknown;
  read(dir: string): Promise<unknown>;
  resolveRoot(cwd: string): Promise<unknown>;
  resolve(cwd: string, options?: { allowNestedInherit?: boolean }): Promise<unknown>;
  find?(cwd: string): Promise<unknown>;
}

export function runIdentityFixtureSuite(
  register: (name: string, run: () => void | Promise<void>) => unknown,
  adapter: IdentityFixtureAdapter
): void;
