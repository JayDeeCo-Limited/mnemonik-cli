import { describe, expect, it, vi } from 'vitest';
import { createHttpInstallSessionTransport, reportInstall } from '../src/installSession.js';
import { Output } from '../src/output.js';

const secret64 = 'a'.repeat(64);
const bearer = 'Bearer access-token-value';
const key = `mnk_${'b'.repeat(40)}`;
const component = `mnc_${'c'.repeat(40)}`;
const beforeHash = `sha256:${'d'.repeat(64)}`;
const afterHash = `sha256:${'e'.repeat(64)}`;
const email = 'sam@example.com';
const home = '/home/sam';

describe('redacted output funnel', () => {
  it('removes secrets and home paths from JSON and the install-session report', async () => {
    const stream = {
      text: '',
      write(chunk: string) {
        this.text += chunk;
      },
    };
    const output = new Output(stream, stream, { home });
    output.json({
      authorization: 'Basic authorization value',
      bearer,
      token: key,
      component,
      hash: secret64,
      error: `sha256:${secret64}`,
      record: { beforeHash, afterHash },
      email,
      path: `${home}/.config/private`,
    });
    await reportInstall(
      {
        installation: {
          conditions: [
            {
              kind: 'selected_component_failed',
              reason: `${home}/code/project ${email}`,
            },
          ],
        },
        steps: [{ name: 'test', status: 'FAILED', action: `${bearer} ${key} ${secret64}` }],
      },
      output
    );
    for (const secret of [bearer, key, component, secret64, email, home, 'authorization value'])
      expect(stream.text).not.toContain(secret);
    expect(JSON.parse(stream.text.split('\n')[0]!)).toMatchObject({
      error: 'sha256:[REDACTED]',
      record: { beforeHash, afterHash },
    });
    expect(stream.text).toContain('~/.config/private');
  });

  it('GETs current then POSTs the canonical body only for READY', async () => {
    const fetcher = vi.fn(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        _init?: Parameters<typeof globalThis.fetch>[1]
      ) => new Response(JSON.stringify({ id: 'session-id' }), { status: 200 })
    );
    const transport = createHttpInstallSessionTransport('secret-access', fetcher);
    const stream = {
      text: '',
      write(chunk: string) {
        this.text += chunk;
      },
    };
    await reportInstall(
      {
        installation: { conditions: [] },
        projects: [
          {
            projectId: '11111111-1111-4111-8111-111111111111',
            identityFile: null,
            summary: {
              conditions: [
                {
                  kind: 'project_uncovered',
                  reason: 'Project is outside approved roots.',
                  action: 'mnemonik add /work/acme',
                },
              ],
            },
          },
        ],
        steps: [],
      },
      new Output(stream),
      transport,
      true
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-access',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toHaveProperty(
      'readiness.installation.state',
      'READY'
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      readiness: {
        projects: [
          {
            projectId: '11111111-1111-4111-8111-111111111111',
            identityFile: null,
            summary: { state: 'LIMITED' },
          },
        ],
      },
    });
    fetcher.mockClear();
    await reportInstall(
      {
        installation: {
          conditions: [{ kind: 'scanner_omitted', reason: 'Limited mode.' }],
        },
        steps: [],
      },
      new Output(stream),
      transport,
      true
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('turns a failed final upload into FAILED readiness through the reducer', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 500 }));
    const stream = {
      text: '',
      write(chunk: string) {
        this.text += chunk;
      },
    };
    await reportInstall(
      { installation: { conditions: [] }, steps: [] },
      new Output(stream),
      createHttpInstallSessionTransport('secret-access', fetcher),
      true
    );
    expect(JSON.parse(stream.text)).toMatchObject({
      installation: {
        state: 'FAILED',
        reasons: ['The final installation status could not be uploaded.'],
      },
      installSession: { status: 'report_failed' },
    });
  });
});
