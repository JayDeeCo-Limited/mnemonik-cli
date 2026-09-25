import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const macComputerName = async () =>
  (
    await promisify(execFile)('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 2000,
    })
  ).stdout;

/**
 * The name the owner gave this machine, sent once at sign-in (L-44). On macOS
 * that is the Computer Name ("Mac Mini"), not the network host name a router
 * hands out ("home.localdomain"); on Windows and Linux the host name is the
 * name the owner set. A rename in the console outranks it on the server.
 */
export async function machineName(
  platform: NodeJS.Platform = process.platform,
  computerName: () => Promise<string> = macComputerName
): Promise<string> {
  if (platform === 'darwin') {
    const name = await computerName().then(
      (value) => value.trim(),
      () => ''
    );
    if (name) return name;
  }
  return hostname();
}
